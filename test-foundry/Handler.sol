// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";

/**
 * Handler — the thing the fuzzer actually drives.
 *
 * WHY A HANDLER AND NOT RAW FUZZING. Pointed straight at the wallet, a fuzzer spends its whole
 * budget being rejected by `onlyOwners` and never reaches the interesting states. The handler owns
 * the three owner keys, pranks as one of them, and bounds the random inputs into the shapes the
 * contract accepts — so the campaign explores ORDERINGS of legal calls, which is where a
 * state-machine bug actually lives.
 *
 * HOW THE CHECKING WORKS. Before every execute the handler reads the proposal's state, then makes
 * the call. If the call SUCCEEDS, it asserts the pre-state was legal. That is the honest direction:
 * we are not re-implementing the contract's rules and comparing, we are catching the contract
 * letting through something it should have refused.
 */
contract Handler is Test {
    PersonalWallet public w;
    MockUSDC public usdc;
    address[3] public owners;
    address public outsider = address(0xBEEF);
    address public allowedTo;

    // ---- ghosts: what the contract ALLOWED, recorded at the moment it allowed it -----------------
    uint256 public executions;              // successful executes of any kind
    uint256 public doubleExecutions;        // an id executed twice — must stay 0
    uint256 public underConfirmed;          // executed with have < need — must stay 0
    uint256 public earlyTimelock;           // executed before effectiveAt — must stay 0
    uint256 public executedAfterCancel;     // executed although cancelled/vetoed — must stay 0
    uint256 public expiredExecuted;         // executed after expiry — must stay 0
    uint256 public toNonAllowlisted;        // paid a non-allowlisted address in strict mode — 0
    uint256 public nativeOut;               // native actually sent out, per the contract's own events
    uint256 public nativeIn;                // native deposited through the handler
    mapping(uint256 => bool) public seenExecuted;

    uint256 public calls;
    uint256 public proposalsMade;
    uint256 public sawExecutable;   // диагностика: колко пъти изобщо е имало готово предложение
    uint256 public maxConfirms;     // диагностика: най-много подписи, събирани някога

    // WHY WE REMEMBER IDS. The first campaign drove 25 600 calls and executed NOTHING: a random
    // uint256 bounded over proposalCount almost never lands twice on the same proposal, so no id
    // ever collected two confirmations and the execute invariants passed vacuously. Keeping the
    // live ids and indexing into them is what lets a sequence actually reach "executable".
    uint256[] public ids;
    function idCount() external view returns (uint256) { return ids.length; }

    constructor(PersonalWallet _w, MockUSDC _usdc, address[3] memory _owners, address _allowedTo) {
        w = _w; usdc = _usdc; owners = _owners; allowedTo = _allowedTo;
    }

    function _owner(uint256 seed) internal view returns (address) { return owners[seed % 3]; }

    /// Reads everything the `executable` guard looks at, BEFORE the call.
    function _pre(uint256 id) internal view returns (bool executed, bool cancelled, bool expired, bool early, bool under) {
        PersonalWallet.Proposal memory p = w.getProposal(id);
        executed = p.executed;
        cancelled = p.cancelled;
        expired = block.timestamp > p.expiresAt;
        uint64 eff = w.effectiveAt(id);
        early = (eff != 0 && block.timestamp < eff);
        under = w.confirmations(id) < w.requiredConfirmations(id);
    }

    /// Called after a SUCCESSFUL execute: if any precondition was illegal, the contract let it through.
    function _audit(uint256 id, bool executed, bool cancelled, bool expired, bool early, bool under) internal {
        executions++;
        if (executed || seenExecuted[id]) doubleExecutions++;
        if (cancelled) executedAfterCancel++;
        if (expired) expiredExecuted++;
        if (early) earlyTimelock++;
        if (under) underConfirmed++;
        seenExecuted[id] = true;
    }

    // ---- funding -------------------------------------------------------------------------------
    function depositNative(uint256 amt) public {
        amt = bound(amt, 1, 10 ether);
        vm.deal(address(this), address(this).balance + amt);
        w.depositNative{value: amt}();
        nativeIn += amt;
        calls++;
    }

    function depositToken(uint256 amt) public {
        amt = bound(amt, 1, 1_000_000e6);
        usdc.mint(address(this), amt);
        usdc.approve(address(w), amt);
        w.depositERC20(address(usdc), amt);
        calls++;
    }

    // ---- proposing -----------------------------------------------------------------------------
    function proposeNative(uint256 who, uint256 amt, uint64 ttl, bool toAllowed, uint256 rnd) public {
        amt = bound(amt, 1, 5 ether);
        ttl = uint64(bound(ttl, 20 days, 30 days));
        address to = toAllowed ? allowedTo : address(uint160(bound(rnd, 1, type(uint160).max)));
        vm.prank(_owner(who));
        try w.proposeNative(to, amt, ttl) returns (uint256 i) { proposalsMade++; ids.push(i); } catch {}
        calls++;
    }

    function proposeERC20(uint256 who, uint256 amt, uint64 ttl, bool toAllowed, uint256 rnd) public {
        amt = bound(amt, 1, 100_000e6);
        ttl = uint64(bound(ttl, 20 days, 30 days));
        address to = toAllowed ? allowedTo : address(uint160(bound(rnd, 1, type(uint160).max)));
        vm.prank(_owner(who));
        try w.proposeERC20(address(usdc), to, amt, ttl) returns (uint256 i) { proposalsMade++; ids.push(i); } catch {}
        calls++;
    }

    function proposeAllowRecipient(uint256 who, uint256 rnd) public {
        address r = address(uint160(bound(rnd, 1, type(uint160).max)));
        vm.prank(_owner(who));
        try w.proposeAllowRecipient(r, "fuzz") returns (uint256 i) { proposalsMade++; ids.push(i); } catch {}
        calls++;
    }

    function proposeOwnerReplacement(uint256 who, uint256 oldSeed, uint256 rnd) public {
        address newOwner = address(uint160(bound(rnd, 1, type(uint160).max)));
        vm.prank(_owner(who));
        try w.proposeOwnerReplacement(owners[oldSeed % 3], newOwner) returns (uint256 i) { proposalsMade++; ids.push(i); } catch {}
        calls++;
    }

    function proposeSetPolicy(uint256 who, uint64 d, bool a, bool b) public {
        d = uint64(bound(d, 24 hours, 30 days));
        vm.prank(_owner(who));
        try w.proposeSetPolicy(d, a, b) returns (uint256 i) { proposalsMade++; ids.push(i); } catch {}
        calls++;
    }

    // ---- voting --------------------------------------------------------------------------------
    function confirm(uint256 who, uint256 id) public {
        id = _boundId(id);
        vm.prank(_owner(who));
        try w.confirm(id) {} catch {}
        calls++;
    }

    /// Confirm with ALL three owners — exactly what scripts/allowlist.js does operationally.
    /// Without this the fuzzer practically never assembles a quorum and nothing is ever executable.
    function confirmAll(uint256 id) public {
        id = _boundId(id);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owners[i]);
            try w.confirm(id) {} catch {}
        }
        calls++;
    }

    function revokeConfirmation(uint256 who, uint256 id) public {
        id = _boundId(id);
        vm.prank(_owner(who));
        try w.revokeConfirmation(id) {} catch {}
        calls++;
    }

    function veto(uint256 who, uint256 id) public {
        id = _boundId(id);
        vm.prank(_owner(who));
        try w.veto(id) {} catch {}
        calls++;
    }

    function cancel(uint256 who, uint256 id) public {
        id = _boundId(id);
        vm.prank(_owner(who));
        try w.cancel(id) {} catch {}
        calls++;
    }

    function acceptOwnerReplacement(uint256 id, uint256 rnd) public {
        id = _boundId(id);
        PersonalWallet.Proposal memory p = w.getProposal(id);
        address caller = p.to == address(0) ? address(uint160(bound(rnd, 1, type(uint160).max))) : p.to;
        vm.prank(caller);
        try w.acceptOwnerReplacement(id) {} catch {}
        calls++;
    }

    // ---- executing — every one audits its own precondition ---------------------------------------
    function executeNative(uint256 who, uint256 id) public {
        id = _boundId(id);
        PersonalWallet.Proposal memory p = w.getProposal(id);
        (bool e, bool c, bool x, bool t, bool u) = _pre(id);
        bool allowedDest = !w.requireAllowedRecipient() || w.isRecipientAllowed(p.to);
        vm.prank(_owner(who));
        try w.executeNative(id) {
            _audit(id, e, c, x, t, u);
            nativeOut += p.value;
            if (!allowedDest) toNonAllowlisted++;
        } catch {}
        calls++;
    }

    function executeERC20(uint256 who, uint256 id) public {
        id = _boundId(id);
        PersonalWallet.Proposal memory p = w.getProposal(id);
        (bool e, bool c, bool x, bool t, bool u) = _pre(id);
        bool allowedDest = !w.requireAllowedRecipient() || w.isRecipientAllowed(p.to);
        vm.prank(_owner(who));
        try w.executeERC20(id) {
            _audit(id, e, c, x, t, u);
            if (!allowedDest) toNonAllowlisted++;
        } catch {}
        calls++;
    }

    function executeAllowRecipient(uint256 who, uint256 id) public {
        id = _boundId(id);
        (bool e, bool c, bool x, bool t, bool u) = _pre(id);
        vm.prank(_owner(who));
        try w.executeAllowRecipient(id) { _audit(id, e, c, x, t, u); } catch {}
        calls++;
    }

    function executeOwnerReplacement(uint256 who, uint256 id) public {
        id = _boundId(id);
        (bool e, bool c, bool x, bool t, bool u) = _pre(id);
        vm.prank(_owner(who));
        try w.executeOwnerReplacement(id) {
            _audit(id, e, c, x, t, u);
            owners = w.owners();      // keep pranking as the CURRENT set
        } catch {}
        calls++;
    }

    function executeSetPolicy(uint256 who, uint256 id) public {
        id = _boundId(id);
        (bool e, bool c, bool x, bool t, bool u) = _pre(id);
        vm.prank(_owner(who));
        try w.executeSetPolicy(id) { _audit(id, e, c, x, t, u); } catch {}
        calls++;
    }

    // ---- time: without this the timelock is never crossed and half the machine stays unexplored --
    // WHY TIME IS BOUNDED SO TIGHTLY. The first three campaigns reached three confirmations on
    // proposals yet NOTHING ever became executable: warp jumped up to 10 days at a time, ~5 times a
    // run, so up to 50 days elapsed inside 100 calls. Every proposal expired (max ttl 30 days) and
    // every matured timelock blew past its 7-day execution window before anyone could act. Time has
    // to move slower than the lifetimes it is competing with.
    function warp(uint256 s) public {
        vm.warp(block.timestamp + bound(s, 1 minutes, 2 hours));
        calls++;
    }

    /// One deliberate jump just past DEFAULT_DELAY (72h) — the only way the timelocked branch is
    /// ever reached — while staying well inside the 7-day execution window.
    function warpPastTimelock(uint256 s) public {
        vm.warp(block.timestamp + bound(s, 72 hours + 1, 72 hours + 6 hours));
        calls++;
    }


    // ---- "execute whatever is ready" ------------------------------------------------------------
    // WHY THIS SHAPE. Picking ONE random id to execute almost never lands on a proposal that is both
    // the right kind and already confirmed: the first two campaigns drove 25 600 calls each and
    // executed nothing, so every execute-related invariant passed VACUOUSLY. An operator does not
    // guess an id either — they execute what is ready. Sweeping all known ids keeps the fuzzer in
    // charge of WHEN execution happens and of everything that happened before it, while guaranteeing
    // that if the contract ever lets an illegal execution through, we are there to see it.
    function executeAnything(uint256 which) public {
        uint256 n = ids.length;
        if (n == 0) { calls++; return; }
        for (uint256 k = 0; k < n; k++) {
            uint256 id = ids[k];
            PersonalWallet.Proposal memory p = w.getProposal(id);
            (bool e, bool c, bool x, bool t, bool u) = _pre(id);
            if (w.isExecutable(id)) sawExecutable++;
            uint256 cf = w.confirmations(id);
            if (cf > maxConfirms) maxConfirms = cf;
            bool allowedDest = !w.requireAllowedRecipient() || w.isRecipientAllowed(p.to);
            address caller = _owner(which + k);
            // Try EVERY door for this id. Picking one kind per sweep meant four out of five
            // attempts hit WrongKind and the executable proposals went unexecuted.
            vm.prank(caller);
            try w.executeNative(id) { _audit(id,e,c,x,t,u); nativeOut += p.value; if (!allowedDest) toNonAllowlisted++; } catch {}
            vm.prank(caller);
            try w.executeERC20(id) { _audit(id,e,c,x,t,u); if (!allowedDest) toNonAllowlisted++; } catch {}
            vm.prank(caller);
            try w.executeAllowRecipient(id) { _audit(id,e,c,x,t,u); } catch {}
            vm.prank(caller);
            try w.executeSetPolicy(id) { _audit(id,e,c,x,t,u); } catch {}
            vm.prank(caller);
            try w.executeOwnerReplacement(id) { _audit(id,e,c,x,t,u); owners = w.owners(); } catch {}
        }
        calls++;
    }

    /// Accept every pending owner replacement, so that branch can actually reach "executable".
    function acceptAll() public {
        for (uint256 k = 0; k < ids.length; k++) {
            PersonalWallet.Proposal memory p = w.getProposal(ids[k]);
            if (p.to == address(0)) continue;
            vm.prank(p.to);
            try w.acceptOwnerReplacement(ids[k]) {} catch {}
        }
        calls++;
    }

    function _boundId(uint256 id) internal view returns (uint256) {
        if (ids.length == 0) return 0;
        return ids[bound(id, 0, ids.length - 1)];
    }

    receive() external payable {}
}
