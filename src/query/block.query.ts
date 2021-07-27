import got from 'got';
import { grabNode, warmNode, coolNode } from './node.query.js';
import { HTTP_TIMEOUT_SECONDS } from '../constants.js';

export interface BlockType {
  nonce: string;
  previous_block: string;
  timestamp: number;
  last_retarget: number;
  diff: string;
  height: number;
  hash: string;
  indep_hash: string;
  txs: Array<string>;
  tx_root: string;
  tx_tree: Array<string>;
  wallet_list: string;
  reward_addr: string;
  tags: Array<string>;
  reward_pool: number;
  weave_size: number;
  block_size: number;
  cumulative_diff: string;
  hash_list_merkle: string;
  poa: {
    option: string;
    tx_path: string;
    chunk: string;
  };
}

// get block by hash is optional (needs proper decoupling)
export async function getBlock({
  hash,
  height,
  gauge,
  completed,
}: {
  hash: string | undefined;
  height: number;
  gauge?: any;
  completed?: string;
}): Promise<BlockType | undefined> {
  const tryNode = grabNode();
  const url = hash
    ? `${tryNode}/block/hash/${hash}`
    : `${tryNode}/block/height/${height}`;
  gauge && gauge.show(`${completed || ''} ${url}`);
  let body;

  try {
    body = await got.get(url, {
      responseType: 'json',
      resolveBodyOnly: true,
    });
  } catch (error) {
    coolNode(tryNode);
    console.error(error);
    return undefined;
  }

  if (hash && height !== body.height) {
    console.error(
      'fatal inconsistency: hash and height dont match for hash:',
      hash,
      height !== body.height
    );
    // REVIEW: does assuming re-forking condition work better than fatal error?
    process.exit(1);
  }
  warmNode(tryNode);
  return body;
}

export async function currentBlock(): Promise<BlockType | undefined> {
  const tryNode = grabNode();
  let jsonPayload;
  try {
    jsonPayload = await got.get(`${tryNode}/block/current`, {
      responseType: 'json',
      resolveBodyOnly: true,
    });
  } catch (error) {
    coolNode(tryNode);
    return undefined;
  }

  warmNode(tryNode);

  return jsonPayload;
}
