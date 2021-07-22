import ProgressBar from 'progress';
import Fluture from 'fluture';
import * as F from 'fluture';
import { DataItemJson } from 'arweave-bundles';
import { config } from 'dotenv';
import { types as CassandraTypes } from 'cassandra-driver';
import {
  serializeBlock,
  serializeTransaction,
  serializeAnsTransaction,
  serializeTags,
} from '../utility/serialize.utility';
// import {
//   streams,
//   initStreams,
//   resetCacheStreams,
// } from '../utility/csv.utility';
import { log } from '../utility/log.utility';
import { ansBundles } from '../utility/ans.utility';
import { mkdir } from '../utility/file.utility';
import { sleep } from '../utility/sleep.utility';
import { TestSuite } from '../utility/mocha.utility';
import { getNodeInfo } from '../query/node.query';
import { block } from '../query/block.query';
import { transaction, tagValue, Tag } from '../query/transaction.query';
import { getDataFromChunks } from '../query/node.query';
import {
  cassandraClient,
  getMaxHeightBlock,
  makeBlockImportQuery,
} from './cassandra.database';
import {
  importBlocks,
  importTransactions,
  importTags,
} from './import.database';
import { DatabaseTag } from './transaction.database';
import { cacheANSEntries } from '../caching/ans.entry.caching';

config();
mkdir('cache');
F.debugMode(true);

export let SIGINT: boolean = false;
export let SIGKILL: boolean = false;
export let bar: ProgressBar;
export let topHeight = 0;
export let currentHeight = 0;
export let unsyncedBlocks = [];
export let timer = setTimeout(() => {}, 0);

let queueIsProcessing = false;
const blockQueue: unknown = {};

const processQueue = (batchSize: number) => {
  const items: any = Object.keys(blockQueue as any)
    .sort()
    .slice(0, batchSize);

  queueIsProcessing = true;
  cassandraClient
    .batch(
      items.map((i: number) => (blockQueue as any)[i]),
      { prepare: true }
    )
    .then(function () {
      items.forEach((i: number) => {
        delete (blockQueue as any)[i];
      });
      queueIsProcessing = false;
    })
    .catch(function (err) {
      console.error('FATAL', err);
      process.exit(1);
    });
};

export function configureSyncBar(start: number, end: number) {
  bar = new ProgressBar(':current/:total blocks synced :percent', {
    curr: start,
    total: end,
  });
  bar.curr = start;
}

async function startPolling(): Promise<void> {
  const nodeInfo = await getNodeInfo({ fullySynced: true });
  if ((nodeInfo && nodeInfo.height) <= currentHeight || !nodeInfo) {
    // wait 30 seconds before polling again
    await new Promise((res) => setTimeout(res, 30 * 1000));
    return startPolling();
  } else if (nodeInfo) {
    const newBlock = await block(nodeInfo.height);
    if (newBlock) {
      currentHeight = Math.max(currentHeight, newBlock.height);
      (blockQueue as any)[
        typeof newBlock.height === 'string'
          ? parseInt(newBlock.height)
          : newBlock.height || 0
      ] = makeBlockImportQuery(newBlock);
      processQueue(1);
    }
    await new Promise((res) => setTimeout(res, 30 * 1000));
    return startPolling();
  }
}

async function prepareBlockStatuses(unsyncedBlocks) {
  for (const blockHeight of unsyncedBlocks) {
    await cassandraClient.execute(
      `INSERT INTO gateway.block IF NOT EXISTS (block_height, synced) (?, ?)`,
      [blockHeight, false],
      { prepare: true }
    );
  }
}

export function startSync() {
  getMaxHeightBlock().then((currentDbMax: CassandraTypes.Long) => {
    const startHeight = currentDbMax.add(1);
    log.info(`[database] starting sync`);
    signalHook();

    getNodeInfo({ fullySynced: false }).then((nodeInfo) => {
      if (nodeInfo) {
        configureSyncBar(startHeight.toInt(), nodeInfo.height);
        if (startHeight.lessThan(nodeInfo.height)) {
          topHeight = nodeInfo.height;
          unsyncedBlocks = R.range(startHeight.toInt(), topHeight + 1);
          prepareBlockStatuses.then(() => {
            bar.tick();

            F.fork((reason: string | void) => {
              console.error('Fatal', reason || '');
              process.exit(1);
            })(() => {
              console.log(
                'Database fully in sync at block height',
                currentHeight,
                'starting polling...'
              );
              startPolling();
            })(
              F.parallel(
                (isNaN as any)(process.env['PARALLEL'])
                  ? 36
                  : parseInt(process.env['PARALLEL'] || '36')
              )(
                unsyncedBlocks.map((h) => {
                  return storeBlock(startHeight, bar);
                })
              )
            );
          });
        } else {
          console.log(
            'database was found to be in sync, starting to poll for new blocks...'
          );
          startPolling();
        }
      } else {
        console.error(
          'Failed to establish any connection to Nodes after 100 retries'
        );
        process.exit(1);
      }
    });
  });
}

export function storeBlock(height: number, bar: ProgressBar): Promise<void> {
  return Fluture(
    (reject: (reason: string | void) => void, resolve: () => void) => {
      let isCancelled = false;
      function getBlock(retry = 0) {
        !isCancelled &&
          block(height)
            .then((currentBlock) => {
              if (currentBlock) {
                // const { formattedBlock, input } = serializeBlock(
                //   currentBlock,
                //   height
                // );
                // console.log(currentBlock, 'FORM', formattedBlock, 'inp', input);
                // initStreams();

                currentHeight = Math.max(currentHeight, currentBlock.height);
                const thisBlockHeight =
                  typeof currentBlock.height === 'string'
                    ? parseInt(currentBlock.height)
                    : currentBlock.height || 0;
                (blockQueue as any)[thisBlockHeight] = makeBlockImportQuery(
                  currentBlock
                );
                // streams.block.cache.write(input);
                // storeTransaction(
                //   JSON.parse(formattedBlock.txs) as Array<string>,
                //   height
                // );
                log.info(
                  `Sending block height ${thisBlockHeight} to the queue (${
                    Object.keys(blockQueue as any).length
                  }/5)`
                );
                // 5 is arbitrary but low enough to prevent "Batch too large" errors
                if (Object.keys(blockQueue as any).length >= 5) {
                  processQueue(5);
                }
                bar.tick();
                resolve();
              } else {
                new Promise((res) => setTimeout(res, 100)).then(() => {
                  if (retry >= 250) {
                    log.info(`Could not retrieve block at height ${height}`);
                    reject('Failed to fetch block after 250 retries');
                  } else {
                    return getBlock(retry + 1);
                  }
                });
              }
            })
            .catch((error) => {
              log.error(`error ${error}`);
              if (SIGKILL === false) {
                if (retry >= 250) {
                  log.info(`there were problems retrieving ${height}`);
                  reject(error);
                } else {
                  return getBlock(retry + 1);
                }
              }
            });
      }
      console.log('fetching', height);
      getBlock();
      return () => {
        isCancelled = true;
      };
    }
  );
}

export async function storeTransaction(tx: string, height: number) {
  const currentTransaction = await transaction(tx);
  if (currentTransaction) {
    const { formattedTransaction, preservedTags, input } = serializeTransaction(
      currentTransaction,
      height
    );

    // streams.transaction.cache.write(input);

    storeTags(formattedTransaction.id, preservedTags);

    const ans102 = tagValue(preservedTags, 'Bundle-Type') === 'ANS-102';

    if (ans102) {
      await processAns(formattedTransaction.id, height);
    }
  } else {
    console.error('Fatal network error');
    process.exit(1);
  }
}

export async function processAns(
  id: string,
  height: number,
  retry: boolean = true
) {
  try {
    const ansPayload = await getDataFromChunks(id);
    const ansTxs = await ansBundles.unbundleData(ansPayload.toString('utf-8'));

    await cacheANSEntries(ansTxs);
    await processANSTransaction(ansTxs, height);
  } catch (error) {
    if (retry) {
      await processAns(id, height, false);
    } else {
      log.info(
        `[database] malformed ANS payload at height ${height} for tx ${id}`
      );
      // streams.rescan.cache.write(`${id}|${height}|ans\n`);
    }
  }
}

export async function processANSTransaction(
  ansTxs: Array<DataItemJson>,
  height: number
) {
  for (let i = 0; i < ansTxs.length; i++) {
    const ansTx = ansTxs[i];
    const { ansTags, input } = serializeAnsTransaction(ansTx, height);

    // streams.transaction.cache.write(input);

    for (let ii = 0; ii < ansTags.length; ii++) {
      const ansTag = ansTags[ii];
      const { name, value } = ansTag;

      const tag: DatabaseTag = {
        tx_id: ansTx.id,
        index: ii,
        name: name || '',
        value: value || '',
      };

      const input = `"${tag.tx_id}"|"${tag.index}"|"${tag.name}"|"${tag.value}"\n`;

      // streams.tags.cache.write(input);
    }
  }
}

export function storeTags(tx_id: string, tags: Array<Tag>) {
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const { input } = serializeTags(tx_id, i, tag);
    // streams.tags.cache.write(input);
  }
}

export function signalHook() {
  if (!TestSuite) {
    process.on('SIGINT', () => {
      log.info(
        '[database] ensuring all blocks are stored before exit, you may see some extra output in console'
      );
      SIGKILL = true;
      setInterval(() => {
        if (SIGINT === false) {
          log.info('[database] block sync state preserved, now exiting');
          console.log('');
          process.exit();
        }
      }, 100);
    });
  }
}
