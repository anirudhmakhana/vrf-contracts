import hre from "hardhat";
import { assert, expect } from "chai";
import { Web3FunctionHardhat } from "@gelatonetwork/web3-functions-sdk/hardhat-plugin";
import { ContractFactory } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { GelatoVRFInbox, MockVRFConsumer } from "../typechain";
import { Web3FunctionUserArgs } from "@gelatonetwork/automate-sdk";
import { Web3FunctionResultV2 } from "@gelatonetwork/web3-functions-sdk/*";
const { deployments, w3f, ethers } = hre;
import {
  ChainOptions,
  fetchBeacon,
  HttpCachingChain,
  HttpChainClient,
  roundAt,
} from "drand-client";
import { quicknet } from "../src/drand_info";

const DRAND_OPTIONS: ChainOptions = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: {
    chainHash: quicknet.hash,
    publicKey: quicknet.public_key,
  },
};

describe("VRF Test Suite", function () {
  // Signers
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;
  let dedicatedMsgSender: SignerWithAddress;

  // Web 3 Functions
  let vrf: Web3FunctionHardhat;
  let userArgs: Web3FunctionUserArgs;

  // Factories
  let inboxFactory: ContractFactory;
  let mockConsumerFactory: ContractFactory;

  // Contracts
  let inbox: GelatoVRFInbox;
  let mockConsumer: MockVRFConsumer;

  // Drand testing client
  let chain: HttpCachingChain;
  let client: HttpChainClient;

  before(async function () {
    await deployments.fixture();
    [deployer, user, dedicatedMsgSender] = await ethers.getSigners();

    // Web 3 Functions
    vrf = w3f.get("vrf");

    // Solidity contracts
    inboxFactory = await ethers.getContractFactory("GelatoVRFInbox");

    mockConsumerFactory = await ethers.getContractFactory(
      "contracts/MockConsumer.sol:MockVRFConsumer"
    );

    // Drand testing client
    chain = new HttpCachingChain(
      `https://api.drand.sh/${quicknet.hash}`,
      DRAND_OPTIONS
    );
    client = new HttpChainClient(chain, DRAND_OPTIONS);
  });

  this.beforeEach(async () => {
    inbox = (await inboxFactory.connect(deployer).deploy()) as GelatoVRFInbox;
    mockConsumer = (await mockConsumerFactory
      .connect(deployer)
      .deploy(inbox.address, dedicatedMsgSender.address)) as MockVRFConsumer;
    userArgs = { inbox: inbox.address, allowedSenders: [] };
  });

  const data = []; // TODO; test data
  it("Stores the latest round in the mock consumer", async () => {
    await inbox.connect(user).requestRandomness(mockConsumer.address, data);

    (userArgs.allowedSenders as string[]).push(user.address);

    const exec = await vrf.run({ userArgs });
    const res = exec.result as Web3FunctionResultV2;
    const round = roundAt(Date.now(), quicknet);

    if (!res.canExec) assert.fail(res.message);

    res.callData.forEach(
      async (callData) => await dedicatedMsgSender.sendTransaction(callData)
    );

    const { randomness } = await fetchBeacon(client, round);

    expect(await mockConsumer.latestRandomness()).to.equal(
      ethers.BigNumber.from(`0x${randomness}`)
    );
  });

  it("When paused it catches up the specified amount of blocks", async () => {
    (userArgs.allowedSenders as string[]).push(user.address);

    // Simulates request to ignore
    await inbox.connect(user).requestRandomness(mockConsumer.address, data);

    // Triggers pause condition
    for (let i = 0; i < 1001; ++i) ethers.provider.send("evm_mine", []);

    // Spams requests, only the last MAX_RANGE * MAX_REQUESTS should be picked up
    for (let i = 0; i < 1000; ++i) {
      await inbox.connect(user).requestRandomness(mockConsumer.address, data);
    }

    const exec = await vrf.run({ userArgs });
    const res = exec.result as Web3FunctionResultV2;

    if (!res.canExec) assert.fail(res.message);

    expect(res.callData).to.have.lengthOf(500);
  });

  it("Doesn't execute if no event was emitted", async () => {
    const exec = await vrf.run({ userArgs });
    const res = exec.result as Web3FunctionResultV2;

    if (!res.canExec) assert.fail(res.message);
    expect(res.callData).to.have.lengthOf(0);
  });
});
