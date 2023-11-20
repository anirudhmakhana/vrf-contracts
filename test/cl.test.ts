import { Web3FunctionUserArgs } from "@gelatonetwork/automate-sdk";
import { Web3FunctionResultV2 } from "@gelatonetwork/web3-functions-sdk/*";
import { Web3FunctionHardhat } from "@gelatonetwork/web3-functions-sdk/hardhat-plugin";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { assert, expect } from "chai";
import {
  ChainOptions,
  HttpCachingChain,
  HttpChainClient,
  fetchBeacon,
  roundAt,
} from "drand-client";
import { ContractFactory } from "ethers";
import hre from "hardhat";
import { quicknet } from "../src/drand_info";
import { MockVRFConsumer, VRFCoordinatorV2Adapter } from "../typechain";
const { deployments, w3f, ethers } = hre;

import { sleep } from "drand-client/util";
import fetch from "node-fetch";
global.fetch = fetch;

const DRAND_OPTIONS: ChainOptions = {
  disableBeaconVerification: false,
  noCache: true,
  chainVerificationParams: {
    chainHash: quicknet.hash,
    publicKey: quicknet.public_key,
  },
};

describe("Chainlink Adapter Test Suite", function () {
  // Signers
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;

  // Web 3 Functions
  let vrf: Web3FunctionHardhat;
  let userArgs: Web3FunctionUserArgs;

  // Factories
  let adapterFactory: ContractFactory;
  let mockConsumerFactory: ContractFactory;

  // Contracts
  let adapter: VRFCoordinatorV2Adapter;
  let mockConsumer: MockVRFConsumer;

  // Drand testing client
  let chain: HttpCachingChain;
  let client: HttpChainClient;

  before(async function () {
    await deployments.fixture();
    [deployer, user] = await ethers.getSigners();

    // Web 3 Functions
    vrf = w3f.get("vrf");

    // Solidity contracts
    adapterFactory = await ethers.getContractFactory("VRFCoordinatorV2Adapter");
    mockConsumerFactory = await ethers.getContractFactory(
      "contracts/chainlink_compatible/mocks/MockVRFConsumer.sol:MockVRFConsumer"
    );

    // Drand testing client
    chain = new HttpCachingChain(
      `https://api.drand.sh/${quicknet.hash}`,
      DRAND_OPTIONS
    );
    client = new HttpChainClient(chain, DRAND_OPTIONS);
  });

  this.beforeEach(async () => {
    const operator = deployer.address;
    const roundsToFulfill = 4;
    adapter = (await adapterFactory
      .connect(deployer)
      .deploy(
        operator,
        operator,
        [],
        roundsToFulfill
      )) as VRFCoordinatorV2Adapter;
    mockConsumer = (await mockConsumerFactory
      .connect(deployer)
      .deploy(adapter.address)) as MockVRFConsumer;
    userArgs = { consumerAddress: adapter.address };

    await adapter
      .connect(deployer)
      .updateRequesterPermissions([mockConsumer.address], true);
  });

  it("Stores the latest round in the mock consumer", async () => {
    const numWords = 3;

    await mockConsumer.connect(user).requestRandomWords(numWords);
    const requestId = await mockConsumer.requestId();

    const exec = await vrf.run({ userArgs });
    const res = exec.result as Web3FunctionResultV2;
    const round = roundAt(Date.now(), quicknet);

    if (!res.canExec) assert.fail(res.message);

    expect(res.callData).to.have.lengthOf(1);
    const calldata = res.callData[0];
    await deployer.sendTransaction({ to: calldata.to, data: calldata.data });

    const { randomness } = await fetchBeacon(client, round);

    const abi = ethers.utils.defaultAbiCoder;
    const seed = ethers.utils.keccak256(
      abi.encode(
        ["uint256", "address", "uint256", "uint256"],
        [
          ethers.BigNumber.from(`0x${randomness}`),
          adapter.address,
          (await ethers.provider.getNetwork()).chainId,
          requestId,
        ]
      )
    );
    for (let i = 0; i < numWords; i++) {
      const expected = ethers.utils.keccak256(
        abi.encode(["bytes32", "uint32"], [seed, i])
      );
      const actual = await mockConsumer.randomWordsOf(requestId, i);
      expect(actual._hex).to.equal(expected);
    }
  });

  it("Doesnt store the last round after round elapsed", async () => {
    // Deploy adapter with roundsToFulfill = 1
    const roundsToFulfill = 1;
    const operator = deployer.address;
    adapter = (await adapterFactory
      .connect(deployer)
      .deploy(
        operator,
        operator,
        [],
        roundsToFulfill
      )) as VRFCoordinatorV2Adapter;
    mockConsumer = (await mockConsumerFactory
      .connect(deployer)
      .deploy(adapter.address)) as MockVRFConsumer;
    userArgs = { consumerAddress: adapter.address };
    await adapter
      .connect(deployer)
      .updateRequesterPermissions([mockConsumer.address], true);

    const numWords = 1;

    await mockConsumer.connect(user).requestRandomWords(numWords);
    const requestId = await mockConsumer.requestId();
    const requestDeadline = await adapter.requestDeadline(requestId);

    // catch up to block time (block time is faster than Date.now() in tests)
    const blockTimeNow =
      (await ethers.provider.getBlock("latest")).timestamp * 1000;
    await sleep(blockTimeNow - Date.now());

    const exec = await vrf.run({ userArgs });

    const res = exec.result as Web3FunctionResultV2;
    if (!res.canExec) assert.fail(res.message);

    // wait until past deadline
    await sleep((roundsToFulfill + 3) * quicknet.period * 1000);

    const round = roundAt(Date.now(), quicknet);
    expect(round).to.be.gt(requestDeadline);

    const calldata = res.callData[0];
    await deployer.sendTransaction({ to: calldata.to, data: calldata.data });

    await expect(mockConsumer.randomWordsOf(requestId, 0)).to.be.reverted;
  });

  it("Doesn't execute if no event was emitted", async () => {
    const exec = await vrf.run({ userArgs });
    const res = exec.result as Web3FunctionResultV2;

    if (!res.canExec) assert.fail(res.message);
    expect(res.callData).to.have.lengthOf(0);
  });
});
