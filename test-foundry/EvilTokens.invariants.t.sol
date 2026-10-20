// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDT, MockUSDC, MockEURC} from "../contracts/mocks/TestTokens.sol";
import {LyingERC20, BlackHoleERC20} from "../contracts/mocks/Attackers.sol";

interface IBal { function balanceOf(address) external view returns (uint256); }

/**
 * Campaign 2 — the same wallet, driven with tokens that misbehave the way real ones do.
 *
 * The first campaign used one well-behaved ERC20. Real stablecoins are not well behaved: USDT takes
 * a fee on transfer and its `transfer` returns NOTHING, USDC blocklists addresses, EURC can pause
 * globally, and a hostile token can simply lie. The question these invariants ask is narrow and
 * brutal: **can the wallet ever believe it holds more than it does, or mark a proposal executed when
 * the asset did not actually move?**
 */
contract EvilTokenHandler is Test {
    PersonalWallet public w;
    MockUSDT public usdt;      // fee-on-transfer, transfer() returns nothing
    MockUSDC public usdc;      // blocklist
    MockEURC public eurc;      // global pause
    LyingERC20 public liar;    // reports success it did not deliver
    BlackHoleERC20 public hole;// swallows the transfer
    address[3] public owners;
    address public dest;

    address[5] public toks;
    uint256 public execsERC20;
    uint256 public walletOverstated;   // wallet claims more than it holds — must stay 0
    uint256 public executedWithoutMove;// marked executed while nothing left the wallet — must stay 0
    uint256 public lyingTokenExecuted; // same, but caused by a token that lies — FINDING 1, counted not asserted
    uint256 public calls;
    uint256[] public ids;

    constructor(PersonalWallet _w, MockUSDT a, MockUSDC b, MockEURC c, LyingERC20 d, BlackHoleERC20 e,
                address[3] memory _o, address _dest) {
        w = _w; usdt = a; usdc = b; eurc = c; liar = d; hole = e; owners = _o; dest = _dest;
        toks = [address(a), address(b), address(c), address(d), address(e)];
    }

    function _owner(uint256 s) internal view returns (address) { return owners[s % 3]; }
    function _tok(uint256 s) internal view returns (address) { return toks[s % 5]; }

    // ---- the tokens' nastiness, under the fuzzer's control --------------------------------------
    function setFee(uint256 bps, uint256 maxFee) public {
        usdt.setParams(bound(bps, 0, 19), bound(maxFee, 0, 1_000e6));
        calls++;
    }
    function setPaused(bool p) public { eurc.setPaused(p); calls++; }
    function setBlocked(bool b, uint256 which) public {
        usdc.setBlocked(which % 2 == 0 ? dest : address(w), b);
        calls++;
    }

    function depositAny(uint256 which, uint256 amt) public {
        address t = _tok(which);
        amt = bound(amt, 1, 1_000_000e6);
        (bool ok,) = t.call(abi.encodeWithSignature("mint(address,uint256)", address(this), amt));
        if (!ok) { calls++; return; }
        (ok,) = t.call(abi.encodeWithSignature("approve(address,uint256)", address(w), amt));
        try w.depositERC20(t, amt) {} catch {}
        calls++;
    }

    function proposeERC20(uint256 who, uint256 which, uint256 amt, uint64 ttl) public {
        amt = bound(amt, 1, 100_000e6);
        ttl = uint64(bound(ttl, 20 days, 30 days));
        vm.prank(_owner(who));
        try w.proposeERC20(_tok(which), dest, amt, ttl) returns (uint256 i) { ids.push(i); } catch {}
        calls++;
    }

    function confirmAll(uint256 i) public {
        if (ids.length == 0) { calls++; return; }
        uint256 id = ids[bound(i, 0, ids.length - 1)];
        for (uint256 k; k < 3; k++) { vm.prank(owners[k]); try w.confirm(id) {} catch {} }
        calls++;
    }

    /// Execute everything ready, and check the wallet's story against the token's own ledger.
    function executeAll(uint256 who) public {
        for (uint256 k; k < ids.length; k++) {
            uint256 id = ids[k];
            PersonalWallet.Proposal memory p = w.getProposal(id);
            if (p.executed || p.cancelled) continue;
            uint256 realBefore = IBal(p.token).balanceOf(address(w));
            vm.prank(_owner(who + k));
            try w.executeERC20(id) {
                execsERC20++;
                uint256 realAfter = IBal(p.token).balanceOf(address(w));
                // THE QUESTION: the proposal is now marked executed. Did the asset actually leave?
                // Scoped to the three REALISTIC tokens. USDT (fee), USDC (blocklist) and EURC
                // (pause) must either move the balance or revert the whole execute. The two hostile
                // ones are excluded here on purpose: a token that returns `true` without moving
                // anything cannot be caught by any caller, and the campaign already proved the
                // wallet marks such a proposal executed — recorded as FINDING 1 in INVARIANTS.md,
                // with its own explicit test, rather than left as a permanently red invariant.
                bool realistic = p.token == address(usdt) || p.token == address(usdc) || p.token == address(eurc);
                if (realistic && realAfter >= realBefore) executedWithoutMove++;
                if (!realistic && realAfter >= realBefore) lyingTokenExecuted++;
            } catch {}
        }
        calls++;
    }

    /// After every call: the wallet must never claim more than the token says it has.
    function checkBalances() public {
        for (uint256 i; i < 5; i++) {
            if (w.erc20Balance(toks[i]) > IBal(toks[i]).balanceOf(address(w))) walletOverstated++;
        }
        calls++;
    }

    function warp(uint256 s) public { vm.warp(block.timestamp + bound(s, 1 minutes, 2 hours)); calls++; }
    function idCount() external view returns (uint256) { return ids.length; }
}

contract EvilTokenInvariants is Test {
    PersonalWallet w; EvilTokenHandler h;
    MockUSDT usdt; MockUSDC usdc; MockEURC eurc; LyingERC20 liar; BlackHoleERC20 hole;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        usdt = new MockUSDT(); usdc = new MockUSDC(); eurc = new MockEURC();
        liar = new LyingERC20(); hole = new BlackHoleERC20();

        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](5); string[] memory tl = new string[](5);
        t[0]=address(usdt); t[1]=address(usdc); t[2]=address(eurc); t[3]=address(liar); t[4]=address(hole);
        tl[0]="USDT"; tl[1]="USDC"; tl[2]="EURC"; tl[3]="LIAR"; tl[4]="HOLE";

        w = new PersonalWallet([o1,o2,o3], true, true, r, rl, t, tl);
        h = new EvilTokenHandler(w, usdt, usdc, eurc, liar, hole, [o1,o2,o3], dest);

        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](14);
        sel[0]=EvilTokenHandler.depositAny.selector;      sel[1]=EvilTokenHandler.depositAny.selector;
        sel[2]=EvilTokenHandler.proposeERC20.selector;    sel[3]=EvilTokenHandler.proposeERC20.selector;
        sel[4]=EvilTokenHandler.confirmAll.selector;      sel[5]=EvilTokenHandler.confirmAll.selector;
        sel[6]=EvilTokenHandler.executeAll.selector;      sel[7]=EvilTokenHandler.executeAll.selector;
        sel[8]=EvilTokenHandler.setFee.selector;          sel[9]=EvilTokenHandler.setPaused.selector;
        sel[10]=EvilTokenHandler.setBlocked.selector;     sel[11]=EvilTokenHandler.checkBalances.selector;
        sel[12]=EvilTokenHandler.warp.selector;           sel[13]=EvilTokenHandler.checkBalances.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// THE BIG ONE. If the wallet ever believes it holds more of a token than the token says, every
    /// later proposal against that balance is built on a lie.
    function invariant_walletNeverOverstatesItsBalance() public view {
        assertEq(h.walletOverstated(), 0, "wallet claims more than the token ledger shows");
        for (uint256 i; i < 5; i++) {
            address t = h.toks(i);
            assertLe(w.erc20Balance(t), IBal(t).balanceOf(address(w)), "erc20Balance() overstates");
        }
    }

    /// A proposal marked executed while the asset never left is an accounting hole.
    function invariant_executedMeansItActuallyMoved() public view {
        assertEq(h.executedWithoutMove(), 0, "marked executed but the balance did not fall");
    }

    function invariant_ownersStillIntact() public view {
        address[3] memory o = w.owners();
        assertTrue(o[0] != o[1] && o[1] != o[2] && o[0] != o[2], "owners corrupted");
    }

    function afterInvariant() public view {
        console2.log("calls           :", h.calls());
        console2.log("proposals       :", h.idCount());
        console2.log("ERC20 executions:", h.execsERC20());
        console2.log("USDT in wallet  :", usdt.balanceOf(address(w)));
        console2.log("wallet says USDT:", w.erc20Balance(address(usdt)));
        console2.log("FINDING-1 hits  :", h.lyingTokenExecuted());
    }
}
