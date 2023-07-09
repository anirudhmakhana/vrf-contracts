import * as ethers from "ethers";
import shuffle from "lodash/shuffle";
import { Log } from "@ethersproject/providers";
import { Contract } from "ethers";

import {
  Web3Function,
  Web3FunctionContext,
} from "@gelatonetwork/web3-functions-sdk";

import {
  fetchBeacon,
  HttpChainClient,
  HttpCachingChain,
  ChainOptions,
} from "drand-client";
import { hexZeroPad } from "ethers/lib/utils";

// contract abis
const ADAPTER_ABI = [
  `event RandomnessRequest(
        address indexed sender,
        uint32 numWords,
        uint256 requestId,
        uint64 roundNumber,
        address consumer
    )`,
  `function fulfillRandomWords(
        uint32 numWords,
        uint256 requestId,
        uint256 randomness,
        address consumer
    ) external`,
];

// w3f constants
const MAX_DEPTH = 700;
const MAX_RANGE = 100; // limit range of events to comply with rpc providers
const MAX_REQUESTS = 100; // limit number of requests on every execution to avoid hitting timeout

// drand constants
const FASTNET_CHAIN_HASH =
  "dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493";
const PUBLIC_KEY =
  "a0b862a7527fee3a731bcb59280ab6abd62d5c0b6ea03dc4ddf6612fdfc9d01f01c31542541771903475eb1ec6615f8d0df0b8b6dce385811d6dcf8cbefb8759e5e616a3dfd054c928940766d9a5b9db91e3b697e5d70a975181e007f87fca5e";

const DRAND_OPTIONS: ChainOptions = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: {
    chainHash: FASTNET_CHAIN_HASH,
    publicKey: PUBLIC_KEY,
  },
};

async function fetchDrandResponse(round?: number) {
  // sequentially try different endpoints, in shuffled order for load-balancing
  const urls = shuffle([
    // Protocol labs endpoints
    "https://api.drand.sh",
    "https://api2.drand.sh",
    "https://api3.drand.sh",
    // Cloudflare
    "https://drand.cloudflare.com",
    // Storswift
    "https://api.drand.secureweb3.com:6875",
  ]);

  console.log("Fetching randomness");
  const errors: Error[] = [];
  for (const url of urls) {
    console.log(`Trying ${url}...`);
    const chain = new HttpCachingChain(
      `${url}/${FASTNET_CHAIN_HASH}`,
      DRAND_OPTIONS
    );
    const client = new HttpChainClient(chain, DRAND_OPTIONS);
    try {
      return await fetchBeacon(client, round);
    } catch (err) {
      errors.push(err as Error);
    }
  }
  throw errors.pop();
}

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { userArgs, storage, multiChainProvider } = context;

  const provider = multiChainProvider.default();

  const allowedSenders = userArgs.allowedSenders as string[];
  const adapterAddress = userArgs.adapter as string;
  const adapter = new Contract(adapterAddress, ADAPTER_ABI, provider);

  const currentBlock = await provider.getBlockNumber();
  const lastBlockStr = await storage.get("lastBlockNumber");
  let lastBlock = lastBlockStr
    ? parseInt(lastBlockStr)
    : currentBlock - MAX_DEPTH;

  const topics = [
    adapter.interface.getEventTopic("RandomnessRequest"),
    allowedSenders.map((e) => hexZeroPad(e, 32)),
  ];

  // Fetch recent logs in range of 100 blocks
  const logs: Log[] = [];
  let nbRequests = 0;
  while (lastBlock < currentBlock && nbRequests < MAX_REQUESTS) {
    nbRequests++;
    const fromBlock = lastBlock + 1;
    const toBlock = Math.min(fromBlock + MAX_RANGE, currentBlock);
    try {
      const eventFilter = {
        address: adapterAddress,
        topics,
        fromBlock,
        toBlock,
      };
      const result = await provider.getLogs(eventFilter);
      logs.push(...result);
      lastBlock = toBlock;
    } catch (err) {
      return {
        canExec: false,
        message: `Rpc call failed: ${(err as Error).message}`,
      };
    }
  }

  const callData = [];

  // Parse retrieved events
  for (const log of logs) {
    const event = adapter.interface.parseLog(log);
    const [, numWords, requestId, roundNumber, consumer] = event.args;
    const { randomness } = await fetchDrandResponse(roundNumber);
    const encodedRandomness = ethers.BigNumber.from(`0x${randomness}`);
    callData.push({
      to: adapterAddress,
      data: adapter.interface.encodeFunctionData("fulfillRandomWords", [
        numWords,
        requestId,
        encodedRandomness,
        consumer,
      ]),
    });
  }

  return {
    canExec: true,
    callData,
  };
});
