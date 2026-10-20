// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";

/**
 * Campaign 4 — differential testing against an independent reference model.
 *
 * WHY NOT GNOSIS SAFE. The original plan was to diff against Safe. Two things killed it: installing
 * safe-contracts breaks this project's dependency tree (it pins ethers 5.4 and --legacy-peer-deps
 * prunes hardhat-toolbox), and more fundamentally the models are not comparable. Safe signs
 * off-chain with EIP-712 and a nonce; this wallet keeps proposals on-chain. There is no "same call
 * sequence" to run against both, so every divergence would be expected-by-design — noise, not
 * findings. Chasing it would have produced something that looks thorough and proves nothing, which
 * is the exact failure mode docs/INVARIANTS.md already records three times.
 *
 * WHAT IS WORTH DOING INSTEAD. Write the k-of-n rules a second time, deliberately naively — no
 * timelock, no registries, no kinds, just "who proposed, who confirmed, is it executable" — and
 * require the real contract to agree with it on the one question that decides whether money moves.
 * A divergence means one of the two is wrong, and both were written from the same spec.
 */
contract ReferenceMultisig {
    address[3] public owners;
    uint256 public constant THRESHOLD = 2;
    struct P { address to; uint256 value; bool executed; bool cancelled; uint64 expiresAt; }
    mapping(uint256 => P) public props;
    mapping(uint256 => mapping(address => bool)) public confirmed;
    mapping(uint256 => address) public proposer;
    uint256 public count;

    constructor(address[3] memory o) { owners = o; }
    function _isOwner(address a) internal view returns (bool) {
        return a == owners[0] || a == owners[1] || a == owners[2];
    }
    function propose(address to, uint256 value, uint64 ttl) external returns (uint256 id) {
        require(_isOwner(msg.sender), "not owner");
        id = ++count;
        props[id] = P(to, value, false, false, uint64(block.timestamp) + ttl);
        proposer[id] = msg.sender;
        confirmed[id][msg.sender] = true;          // the proposer confirms, same as the wallet
    }
    function confirm(uint256 id) external {
        require(_isOwner(msg.sender) && id != 0 && id <= count, "bad");
        confirmed[id][msg.sender] = true;
    }
    function revoke(uint256 id) external {
        require(_isOwner(msg.sender), "not owner");
        require(!props[id].executed, "executed");
        require(confirmed[id][msg.sender], "not confirmed");   // mirrors NotConfirmed
        confirmed[id][msg.sender] = false;
    }
    /// 🔴 THE DIFFERENTIAL TEST EARNED ITS KEEP HERE. The first version let any owner cancel
    /// anything, and the campaign found the divergence in seven calls. The real contract is
    /// STRICTER, and deliberately so: only the proposer may cancel, and not once the proposal has
    /// reached its threshold — otherwise one owner could pull a decision two owners had already
    /// agreed. The naive model was wrong; the wallet was right. Mirrored.
    function cancel(uint256 id) external {
        require(_isOwner(msg.sender), "not owner");
        P storage p = props[id];
        require(msg.sender == proposer[id], "not proposer");
        require(!p.executed, "executed");
        require(!p.cancelled, "cancelled");
        require(confirmations(id) < THRESHOLD, "confirmations locked");
        p.cancelled = true;
    }
    function markExecuted(uint256 id) external { props[id].executed = true; }
    /// Counted over the CURRENT owners, written out longhand on purpose.
    function confirmations(uint256 id) public view returns (uint256 c) {
        if (confirmed[id][owners[0]]) c++;
        if (confirmed[id][owners[1]]) c++;
        if (confirmed[id][owners[2]]) c++;
    }
    function isExecutable(uint256 id) external view returns (bool) {
        if (id == 0 || id > count) return false;
        P storage p = props[id];
        if (p.executed || p.cancelled) return false;
        if (block.timestamp > p.expiresAt) return false;
        return confirmations(id) >= THRESHOLD;
    }
}

contract DiffHandler is Test {
    PersonalWallet public w;
    ReferenceMultisig public ref;
    address[3] public owners;
    address public dest;
    uint256[] public pairsReal;
    uint256[] public pairsRef;
    uint256 public disagreements;      // must stay 0
    uint256 public comparisons;
    uint256 public calls;

    constructor(PersonalWallet _w, ReferenceMultisig _r, address[3] memory _o, address _d) {
        w = _w; ref = _r; owners = _o; dest = _d;
    }
    function _o(uint256 s) internal view returns (address) { return owners[s % 3]; }
    function pairCount() external view returns (uint256) { return pairsReal.length; }

    /// Every action is applied to BOTH, with the same arguments, from the same owner.
    function propose(uint256 who, uint256 amt, uint64 ttl) public {
        amt = bound(amt, 1, 1 ether); ttl = uint64(bound(ttl, 1 hours, 25 days));
        address a = _o(who);
        vm.prank(a); uint256 r1;
        try w.proposeNative(dest, amt, ttl) returns (uint256 i) { r1 = i; } catch { calls++; return; }
        vm.prank(a); uint256 r2 = ref.propose(dest, amt, ttl);
        pairsReal.push(r1); pairsRef.push(r2);
        calls++;
    }
    function confirm(uint256 who, uint256 k) public {
        if (pairsReal.length == 0) { calls++; return; }
        uint256 i = bound(k, 0, pairsReal.length - 1); address a = _o(who);
        vm.prank(a); try w.confirm(pairsReal[i]) {} catch {}
        vm.prank(a); try ref.confirm(pairsRef[i]) {} catch {}
        calls++;
    }
    function revoke(uint256 who, uint256 k) public {
        if (pairsReal.length == 0) { calls++; return; }
        uint256 i = bound(k, 0, pairsReal.length - 1); address a = _o(who);
        vm.prank(a); try w.revokeConfirmation(pairsReal[i]) {} catch {}
        vm.prank(a); try ref.revoke(pairsRef[i]) {} catch {}
        calls++;
    }
    function cancel(uint256 who, uint256 k) public {
        if (pairsReal.length == 0) { calls++; return; }
        uint256 i = bound(k, 0, pairsReal.length - 1); address a = _o(who);
        vm.prank(a); try w.cancel(pairsReal[i]) {} catch {}
        vm.prank(a); try ref.cancel(pairsRef[i]) {} catch {}
        calls++;
    }
    function execute(uint256 who, uint256 k) public {
        if (pairsReal.length == 0) { calls++; return; }
        uint256 i = bound(k, 0, pairsReal.length - 1);
        vm.prank(_o(who));
        try w.executeNative(pairsReal[i]) { ref.markExecuted(pairsRef[i]); } catch {}
        calls++;
    }
    function warp(uint256 s) public { vm.warp(block.timestamp + bound(s, 1 minutes, 3 days)); calls++; }

    /// THE COMPARISON. Both were written from the same spec; they must answer the same question
    /// the same way.
    function compare() public {
        for (uint256 i; i < pairsReal.length; i++) {
            comparisons++;
            if (w.isExecutable(pairsReal[i]) != ref.isExecutable(pairsRef[i])) disagreements++;
        }
        calls++;
    }
    receive() external payable {}
}

contract DifferentialInvariants is Test {
    PersonalWallet w; ReferenceMultisig ref; DiffHandler h; MockUSDC usdc;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](1); string[] memory tl = new string[](1);
        t[0] = address(usdc); tl[0] = "USDC";
        // Registries OFF: the reference has none, and the point is to diff the k-of-n core only.
        w = new PersonalWallet([o1,o2,o3], false, false, r, rl, t, tl);
        ref = new ReferenceMultisig([o1,o2,o3]);
        h = new DiffHandler(w, ref, [o1,o2,o3], dest);
        vm.deal(address(w), 1000 ether);

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](9);
        sel[0]=DiffHandler.propose.selector;  sel[1]=DiffHandler.propose.selector;
        sel[2]=DiffHandler.confirm.selector;  sel[3]=DiffHandler.confirm.selector;
        sel[4]=DiffHandler.revoke.selector;   sel[5]=DiffHandler.cancel.selector;
        sel[6]=DiffHandler.execute.selector;  sel[7]=DiffHandler.warp.selector;
        sel[8]=DiffHandler.compare.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// Two independent implementations of the same rules must never disagree on whether a proposal
    /// may execute. One disagreement means one of them is wrong.
    function invariant_theTwoImplementationsAgree() public view {
        assertEq(h.disagreements(), 0, "the wallet and the reference model disagree on isExecutable");
    }

    function afterInvariant() public view {
        console2.log("calls       :", h.calls());
        console2.log("pairs       :", h.pairCount());
        console2.log("comparisons :", h.comparisons());
        console2.log("disagreements:", h.disagreements());
    }
}
