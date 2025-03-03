"use strict";
const fs = require("fs");
const net = require("net");
const cassandra = require("cassandra-driver");

require("dotenv").config();
checkEnvVars();

/**
 * CASSANDRA INIT
 */
const retries = 5;
let retryCount = 0;

const KEYSPACE = process.env["KEYSPACE"] ? process.env["KEYSPACE"] : "gateway";

let contactPoints = ["localhost:9042"];
try {
  contactPoints = process.env.CASSANDRA_CONTACT_POINTS
    ? JSON.parse(process.env.CASSANDRA_CONTACT_POINTS)
    : ["localhost:9042"];
} catch (e) {
  console.error("[init] Invalid array of contact points.");
}

async function connect() {
  const client = new cassandra.Client({
    contactPoints,
    localDataCenter: "datacenter1",
    credentials: {
      username: process.env.CASSANDRA_USERNAME,
      password: process.env.CASSANDRA_PASSWORD,
    },
  });

  client
    .connect()
    .then(function () {
      const queries = [
        `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
         WITH replication = {'class': 'SimpleStrategy', 'replication_factor': '1' }`,
        `USE ${KEYSPACE}`,
        `CREATE TABLE IF NOT EXISTS poa (
           option text,
           tx_path text,
           data_path text,
           chunk text,
           block_hash text,
           block_height bigint,
           PRIMARY KEY (block_hash, block_height)
         )
         WITH CLUSTERING ORDER BY (block_height DESC)`,
        `CREATE TABLE IF NOT EXISTS block_height_by_block_hash (
           block_height bigint,
           block_hash text,
           PRIMARY KEY (block_height)
         )`,
        `CREATE TABLE IF NOT EXISTS block (
           block_size bigint,
           cumulative_diff text,
           diff bigint,
           hash text,
           hash_list_merkle text,
           height bigint,
           indep_hash text,
           last_retarget bigint,
           nonce text,
           previous_block text,
           reward_addr text,
           reward_pool bigint,
           tags list<frozen<tuple<text, text>>>,
           timestamp bigint,
           tx_root text,
           tx_tree frozen<list<text>>,
           txs frozen<list<text>>,
           txs_count int,
           wallet_list text,
           weave_size bigint,
           PRIMARY KEY (indep_hash)
         )`,

        `CREATE TABLE IF NOT EXISTS block_gql_asc (
          partition_id text,
          bucket_id text,
          height bigint,
          indep_hash text,
          previous text,
          timestamp bigint,
          PRIMARY KEY ((partition_id, bucket_id), height, timestamp)
        )
        WITH CLUSTERING ORDER BY (height ASC, timestamp ASC)`,

        `CREATE TABLE IF NOT EXISTS block_gql_desc (
          partition_id text,
          bucket_id text,
          height bigint,
          indep_hash text,
          previous text,
          timestamp bigint,
          PRIMARY KEY ((partition_id, bucket_id), height, timestamp)
        )
        WITH CLUSTERING ORDER BY (height DESC, timestamp DESC)`,

        `CREATE TABLE IF NOT EXISTS tx_id_gql_asc (
           partition_id text,
           bucket_id text,
           tx_index bigint,
           tags list<frozen<tuple<text,text>>>,
           tx_id text,
           owner text,
           target text,
           bundle_id text,
           PRIMARY KEY ((partition_id, bucket_id), tx_index)
         )
         WITH CLUSTERING ORDER BY (tx_index ASC)`,

        `CREATE TABLE IF NOT EXISTS tx_id_gql_desc (
           partition_id text,
           bucket_id text,
           tx_index bigint,
           tags list<frozen<tuple<text,text>>>,
           tx_id text,
           owner text,
           target text,
           bundle_id text,
           PRIMARY KEY ((partition_id, bucket_id), tx_index)
         )
         WITH CLUSTERING ORDER BY (tx_index DESC)`,

        `CREATE TABLE IF NOT EXISTS tx_tag (
           partition_id text,
           bucket_id text,
           tx_index bigint,
           tag_index int,
           tx_id text,
           next_tag_index int,
           name text,
           value text,
           PRIMARY KEY ((partition_id, bucket_id), tx_index, tag_index)
        )
        WITH CLUSTERING ORDER BY (tx_index DESC, tag_index DESC)`,

        // reuse tx_id tables for owners filters, optimize later
        `CREATE INDEX IF NOT EXISTS ON tx_id_gql_asc (owner)`,
        `CREATE INDEX IF NOT EXISTS ON tx_id_gql_desc (owner)`,
        // reuse tx_id tables for recipients filters, optimize later
        `CREATE INDEX IF NOT EXISTS ON tx_id_gql_asc (target)`,
        `CREATE INDEX IF NOT EXISTS ON tx_id_gql_desc (target)`,
        // reuse tx_id tables for bundle filters, optimize later
        `CREATE INDEX IF NOT EXISTS ON tx_id_gql_asc (bundle_id)`,
        `CREATE INDEX IF NOT EXISTS ON tx_id_gql_desc (bundle_id)`,

        `CREATE TABLE IF NOT EXISTS tx_tag_gql_by_name_asc (
           partition_id text,
           bucket_id text,
           tx_index bigint,
           tag_index int,
           tag_name text,
           tag_value text,
           tx_id text,
           owner text,
           target text,
           bundle_id text,
           PRIMARY KEY ((partition_id, bucket_id), tx_index, tag_index)
         )
         WITH CLUSTERING ORDER BY (tx_index ASC, tag_index ASC)`,

        `CREATE TABLE IF NOT EXISTS tx_tag_gql_by_name_desc (
           partition_id text,
           bucket_id text,
           tx_index bigint,
           tag_index int,
           tag_name text,
           tag_value text,
           tx_id text,
           owner text,
           target text,
           bundle_id text,
           PRIMARY KEY ((partition_id, bucket_id), tx_index, tag_index)
        )
        WITH CLUSTERING ORDER BY (tx_index DESC, tag_index DESC)`,
        `CREATE INDEX IF NOT EXISTS ON tx_tag_gql_by_name_asc (tag_name)`,
        `CREATE INDEX IF NOT EXISTS ON tx_tag_gql_by_name_desc (tag_name)`,

        `CREATE TABLE IF NOT EXISTS transaction (
          tx_index bigint,
          block_height bigint,
          block_hash text,
          bundled_in text,
          data_root text,
          data_size bigint,
          data_tree frozen<list<text>>,
          format int,
          tx_id text,
          last_tx text,
          owner text,
          quantity bigint,
          reward bigint,
          signature text,
          tags list<frozen<tuple<text,text>>>,
          tag_count int,
          target text,
          PRIMARY KEY (tx_id)
        )`,

        `CREATE TABLE IF NOT EXISTS tx_offset (
         tx_id text,
         size bigint,
         offset bigint,
         PRIMARY KEY(tx_id)
       )`,
        // `CREATE TABLE IF NOT EXISTS manifest (
        //    manifest_url text,
        //    manifest_id text,
        //    tx_id text,
        //    path text,
        //    PRIMARY KEY(manifest_id, tx_id)
        //  )
        //  WITH CLUSTERING ORDER BY (tx_id DESC)`,
      ];
      let p = Promise.resolve();
      // Create the schema executing the queries serially
      queries.forEach((query) => (p = p.then(() => client.execute(query))));
      return p;
    })
    .then(() => {
      console.log("[cassandra] init done");
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);

      console.error("ERRCODE: ", error.code);

      if (error.code == "ECONNREFUSED" && ++retryCount < retries) {
        console.log("[cassandra] Retrying connection...");
        setTimeout(connect, 10000);
        return;
      }

      process.exit(1);
    });
}
connect();

// -------------------------
// Let's confirm every required env var is set, if not, we assume it's running on Docker
function checkEnvVars() {
  if (!process.env.ARWEAVE_NODES || !process.env.ARWEAVE_NODES.length) {
    process.env.ARWEAVE_NODES = '["http://lon-4.eu-west-1.arweave.net:1984"]';
  }

  if (!process.env.PORT || isNaN(process.env.PORT)) {
    process.env.PORT = 3000;
  }

  if (!process.env.PARALLEL || isNaN(process.env.PARALLEL)) {
    process.env.PARALLEL = 32;
  }

  if (!process.env.DB_TIMEOUT || isNaN(process.env.DB_TIMEOUT)) {
    process.env.DB_TIMEOUT = 30;
  }

  if (
    !process.env.HTTP_TIMEOUT_SECONDS ||
    isNaN(process.env.HTTP_TIMEOUT_SECONDS)
  ) {
    process.env.HTTP_TIMEOUT_SECONDS = 15;
  }

  if (
    !process.env.CASSANDRA_CONTACT_POINTS ||
    !process.env.CASSANDRA_CONTACT_POINTS.length
  ) {
    process.env.CASSANDRA_CONTACT_POINTS = '["cassandra"]';
  }

  if (!process.env.KEYSPACE || !process.env.KEYSPACE.length) {
    process.env.KEYSPACE = "gateway";
  }

  if (
    !process.env.CASSANDRA_USERNAME ||
    !process.env.CASSANDRA_USERNAME.length
  ) {
    process.env.CASSANDRA_USERNAME = "cassandra";
  }

  if (
    !process.env.CASSANDRA_PASSWORD ||
    !process.env.CASSANDRA_PASSWORD.length
  ) {
    process.env.CASSANDRA_PASSWORD = "cassandra";
  }
  if (!process.env.CACHE_IMPORT_PATH || !process.env.CACHE_IMPORT_PATH.length) {
    process.env.CACHE_IMPORT_PATH = "cache/imports";
  }

  if (!fs.existsSync(".env")) {
    fs.writeFileSync(
      ".env",
      `ARWEAVE_NODES=${process.env.ARWEAVE_NODES}
  PORT=${process.env.PORT}
  PARALLEL=${process.env.PARALLEL}
  DB_TIMEOUT=${process.env.DB_TIMEOUT}
  HTTP_TIMEOUT_SECONDS=${process.env.HTTP_TIMEOUT_SECONDS}
  CASSANDRA_CONTACT_POINTS=${process.env.CASSANDRA_CONTACT_POINTS}
  KEYSPACE=${process.env.KEYSPACE}
  CASSANDRA_USERNAME=${process.env.CASSANDRA_USERNAME}
  CASSANDRA_PASSWORD=${process.env.CASSANDRA_PASSWORD}`.replace(
        /^\s+|\s+$/gm,
        ""
      ),
      "utf8"
    );
  }
}
