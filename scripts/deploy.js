/**
 * Deploys PersonalWallet.
 *
 *  OWNER_1=0x… OWNER_2=0x… OWNER_3=0x… \
 *  STRICT_RECIPIENTS=true STRICT_TOKENS=true \
 *  RECIPIENTS="0xcold:my cold wallet,0xexch:exchange deposit" \
 *  TOKENS="0xdAC1…:Tether USD,0xA0b8…:USD Coin" \
 *  npx hardhat run scripts/deploy.js --network <net>
 *
 * Owners come from OWNER_1/2/3 if present, else from the addresses behind
 * PRIVATE_KEY_OWNER1/2/3. Nothing is guessed: if three distinct owners cannot be resolved the
 * script stops rather than deploying a wallet with the wrong seats.
 *
 *  If STRICT_RECIPIENTS is true, SEED AT LEAST ONE RECIPIENT YOU CONTROL. The constructor seeds
 *  are active immediately, while anything added later needs all three owners plus the timelock.
 *  That seeded cold address is the escape hatch; without it a wallet with an empty allowlist
 *  cannot send anything for at least 24 hours after deployment, and a hostile owner can veto
 *  every attempt to add one.
 */
const { ethers, network, run, artifacts } = require("hardhat");
const { DeployRecord } = require("./lib/record");

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error("no deployer: set PRIVATE_KEY_DEPLOYER in .env");

  // "0xaddr:label,0xaddr:label"  [[addr, label], …]
  const pairs = (raw) => (raw || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(":");
    if (i < 0) throw new Error(`"${s}" must be written as 0xADDRESS:label`);
    return [ethers.getAddress(s.slice(0, i).trim()), s.slice(i + 1).trim()];
  });

  const strictRecipients = process.env.STRICT_RECIPIENTS === "true";
  const strictTokens = process.env.STRICT_TOKENS === "true";
  const recipients = pairs(process.env.RECIPIENTS);
  const tokens = pairs(process.env.TOKENS);

  const fromEnv = [process.env.OWNER_1, process.env.OWNER_2, process.env.OWNER_3];
  const owners = fromEnv.every(Boolean)
    ? fromEnv.map((a) => ethers.getAddress(a))
    : signers.slice(1, 4).map((s) => s.address);

  if (owners.length !== 3 || owners.some((a) => !a)) {
    throw new Error("could not resolve three owners — set OWNER_1..3 or PRIVATE_KEY_OWNER1..3");
  }
  if (new Set(owners.map((a) => a.toLowerCase())).size !== 3) {
    throw new Error(`the three owners must be distinct: ${owners.join(", ")}`);
  }

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`network   : ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`deployer  : ${deployer.address}  ${ethers.formatEther(bal)}`);
  owners.forEach((a, i) => console.log(`owner ${i + 1}   : ${a}`));
  console.log(`policy    : requireAllowedRecipient=${strictRecipients} requireAllowedToken=${strictTokens}`);
  for (const [a, l] of recipients) console.log(`recipient : ${a}  "${l}"`);
  for (const [a, l] of tokens) console.log(`token     : ${a}  "${l}"`);
  if (bal === 0n) throw new Error("the deployer has no balance — fund it before deploying");

  if (strictRecipients && recipients.length === 0) {
    throw new Error("STRICT_RECIPIENTS=true with no RECIPIENTS seeded. That wallet could not send anything for\n" +
      "at least 24 h, and adding an address later needs all three owners plus the timelock, which\n" +
      "any single owner can veto. Seed a cold address you control, or set STRICT_RECIPIENTS=false."
    );
  }

  const ctorArgs = [
    owners, strictRecipients, strictTokens,
    recipients.map((r) => r[0]), recipients.map((r) => r[1]),
    tokens.map((t) => t[0]), tokens.map((t) => t[1]),
  ];
  const wallet = await (await ethers.getContractFactory("PersonalWallet")).deploy(...ctorArgs);
  await wallet.waitForDeployment();
  const addr = await wallet.getAddress();
  const rc = await wallet.deploymentTransaction().wait();

  console.log(`\nPersonalWallet: ${addr}`);
  console.log(`tx            : ${rc.hash}  (block ${rc.blockNumber}, gas ${rc.gasUsed})`);

  // Read the state back from the chain rather than trusting the constructor arguments.
  const onChain = await wallet.owners();
  for (let i = 0; i < 3; i++) {
    if (onChain[i].toLowerCase() !== owners[i].toLowerCase()) {
      throw new Error(`owner ${i + 1} on chain is ${onChain[i]}, expected ${owners[i]}`);
    }
  }
  // An RPC behind a load balancer can lag a block or two right after a deployment and answer
  // "0x" for a contract that exists — it happened on Sepolia and aborted a successful deploy.
  // So the read-back retries instead of treating one empty answer as failure.
  for (let i = 1; i <= 10; i++) {
    const code = await ethers.provider.getCode(addr);
    if (code && code !== "0x") break;
    if (i === 10) throw new Error(`no code at ${addr} after 10 attempts — the deployment did not take`);
    console.log(`                (the node has not caught up yet, retry ${i}/10)`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Read the policy and the registries back off the chain too, not just the owners.
  if (await wallet.requireAllowedRecipient() !== strictRecipients) throw new Error("recipient policy mismatch on chain");
  if (await wallet.requireAllowedToken() !== strictTokens) throw new Error("token policy mismatch on chain");
  for (const [a] of recipients) {
    if (!(await wallet.isRecipientAllowed(a))) throw new Error(`recipient ${a} is not allowed on chain`);
  }
  for (const [a] of tokens) {
    if (!(await wallet.isTokenAllowed(a))) throw new Error(`token ${a} is not allowed on chain`);
  }
  console.log(`verified      : OWNER_COUNT=${await wallet.OWNER_COUNT()} THRESHOLD=${await wallet.THRESHOLD()}`
    + ` UNANIMOUS=${await wallet.UNANIMOUS()} delay=${await wallet.delay()}s · owners, policy and registries all match`);

  // Every deployment is recorded under deployed/ in a file named by network, date and time.
  const art = await artifacts.readArtifact("PersonalWallet");
  const solc = require("../hardhat.config.js").solidity;
  const rec = new DeployRecord(network.name, (await ethers.provider.getNetwork()).chainId, deployer.address)
    .add({
      name: "PersonalWallet",
      sourceName: art.sourceName,
      address: addr,
      receipt: rc,
      constructorArgs: ctorArgs,
      compiler: { version: solc.version, optimizer: solc.settings.optimizer,
        evmVersion: solc.settings.evmVersion, viaIR: solc.settings.viaIR },
    })
    .set("owners", onChain);
  const { file, latest } = rec.write();
  console.log(`record        : ${file}`);
  console.log(`                ${latest}`);

  if (process.env.VERIFY === "true") {
    console.log("\nverifying source…");
    try {
      await run("verify:verify", { address: addr, constructorArguments: ctorArgs });
    } catch (e) {
      console.log(`verification failed (the deployment is fine): ${e.message.split("\n")[0]}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
