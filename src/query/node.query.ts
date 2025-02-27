import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { types as CassandraTypes } from "cassandra-driver";
import * as R from "rambda";
import rwc from "random-weighted-choice";
import got from "got";
import { log } from "../utility/log.utility";
import { getChunk } from "./chunk.query";
import { HTTP_TIMEOUT_SECONDS } from "../constants";

let temporaryNodes = [];
try {
  temporaryNodes = process.env.ARWEAVE_NODES
    ? JSON.parse(process.env.ARWEAVE_NODES)
    : ["http://lon-4.eu-west-1.arweave.net:1984"];
} catch {
  console.error("[node] invalid list of nodes.");
}
export const NODES = temporaryNodes;

type WeightedNode = { id: string; weight: number };

let nodeTemperatures: WeightedNode[] = [];

const syncNodeTemperatures = () => {
  nodeTemperatures = NODES.map((url: string) => {
    const previousWeight = nodeTemperatures.find(
      (index: WeightedNode) => index.id === url
    );
    return {
      id: url,
      weight: previousWeight ? previousWeight.weight : 1,
    };
  });
};

export function grabNode() {
  R.isEmpty(nodeTemperatures) && syncNodeTemperatures();
  let randomWeightedNode = rwc(nodeTemperatures);

  if (!randomWeightedNode) {
    if (R.isEmpty(nodeTemperatures)) {
      throw new Error("No more peers were found");
    } else {
      randomWeightedNode = nodeTemperatures[0].id;
    }
  }
  return randomWeightedNode.startsWith("http")
    ? randomWeightedNode
    : `http://${randomWeightedNode}`;
}

export function warmNode(url: string) {
  const item = nodeTemperatures.find((index: WeightedNode) => index.id === url);
  if (item) {
    item["weight"] = Math.min(item["weight"] + 1, 99);
  }
}

export function coolNode(url: string, kickIfLow = false) {
  const item = nodeTemperatures.find((index: WeightedNode) => index.id === url);
  if (item) {
    if (kickIfLow && item["weight"] < 2) {
      log.info(
        `[network] peer ${url} is not responding well, if at all, consider removing this node from your list of peers`
      );
      // nodeTemperatures = R.reject((temporary: WeightedNode) =>
      //   R.equals(R.prop("id", temporary), url)
      // )(nodeTemperatures) as WeightedNode[];
    }
    item["weight"] = Math.max(item["weight"] - 1, 1);
  }
}

export interface InfoType {
  network: string;
  version: number;
  release: number;
  height: number;
  current: string;
  blocks: number;
  peers: number;
  queue_length: number;
  node_state_latency: number;
}

export async function getNodeInfo({
  retry = 0,
  maxRetry = 100,
}): Promise<InfoType | undefined> {
  const tryNode = grabNode();

  try {
    const body: any = await got.get(`${tryNode}/info`, {
      responseType: "json",
      resolveBodyOnly: true,
      timeout: HTTP_TIMEOUT_SECONDS * 1000,
      followRedirect: true,
    });

    warmNode(tryNode);

    return {
      network: body.network,
      version: body.version,
      release: body.release,
      height: body.height,
      current: body.current,
      blocks: body.blocks,
      peers: body.peers,
      queue_length: body.queue_length,
      node_state_latency: body.node_state_latency,
    };
  } catch {
    coolNode(tryNode, true);
    return new Promise((resolve) => setTimeout(resolve, 10 + 2 * retry)).then(
      async () => {
        if (retry < maxRetry) {
          return await getNodeInfo({ retry: retry + 1, maxRetry });
        } else {
          console.error(
            "\n" +
              "getNodeInfo: failed to establish connection to any specified node after 100 retries with these nodes: " +
              nodeTemperatures.map(R.prop("id")).join(", ") +
              "\n"
          );

          console.error(
            "\n" +
              "Check the network status, trying again to reach some of these nodes, but it is unlikely to make a differnece:" +
              nodeTemperatures.map(R.prop("id")).join(", ") +
              "\n"
          );
          return await getNodeInfo({ retry: 0, maxRetry });
        }
      }
    );
  }
}

export async function getHashList({
  retry = 0,
}): Promise<string[] | undefined> {
  const hashListCachePath =
    process.env.NODE_ENV === "test"
      ? "cache/hash_list_test.json"
      : "cache/hash_list.json";
  const cacheExists = existsSync(hashListCachePath);

  if (cacheExists) {
    log.info("[database] using hash_list from cache");
    return fs.readFile(hashListCachePath).then((hashListBuf) => {
      try {
        return JSON.parse(hashListBuf.toString());
      } catch {
        console.error("[node] invalid hash_list from cache");
        return [];
      }
    });
  } else {
    const tryNode = grabNode();
    const url = `${tryNode}/hash_list`;
    log.info("[database] fetching the hash_list, this may take a while...");

    try {
      const body = await got.get(url, {
        responseType: "json",
        resolveBodyOnly: true,
        followRedirect: true,
      });

      const linearHashList = R.reverse(body as any);
      return fs
        .writeFile(
          hashListCachePath,
          JSON.stringify(linearHashList, undefined, 2)
        )
        .then(() => linearHashList as string[]);
    } catch (error) {
      process.env.NODE_ENV === "test" && console.error(error);
      coolNode(tryNode);
      return new Promise((resolve) => setTimeout(resolve, 10 + 2 * retry)).then(
        async () => {
          if (retry < 100) {
            return await getHashList({ retry: retry + 1 });
          } else {
            console.error(
              "getHashList: failed to establish connection to any specified node after 100 retries\n"
            );
            process.exit(1);
          }
        }
      );
    }
  }
}

export async function getData(id: string): Promise<any> {
  return await got.get(`${grabNode()}/${id}`);
}

export async function getDataFromChunks({
  id,
  startOffset,
  endOffset,
  retry,
}: {
  id: string;
  retry?: boolean;
  startOffset: CassandraTypes.Long;
  endOffset: CassandraTypes.Long;
}): Promise<Buffer> {
  try {
    let byte = 0;
    let chunks = Buffer.from("");

    while (startOffset.add(byte).lt(endOffset)) {
      const chunk = await getChunk({
        offset: startOffset.add(byte).toString(),
      });
      byte += chunk.parsed_chunk.length;
      chunks = Buffer.concat([chunks, chunk.response_chunk]);
    }

    return chunks;
  } catch (error) {
    if (retry) {
      console.error(
        `error retrieving data from ${id}, please note that this may be a cancelled transaction`
          .red.bold
      );
      return await getDataFromChunks({
        id,
        retry: false,
        startOffset,
        endOffset,
      });
    } else {
      throw error;
    }
  }
}
