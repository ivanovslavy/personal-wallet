// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";
import {BlackHoleERC20} from "../contracts/mocks/Attackers.sol";

/// The one sanity test the invariant campaign needed: prove a legal propose -> confirm -> execute
/// actually works. When three campaigns in a row executed NOTHING, this is what separated "the
/// contract refuses everything" from "the fuzzer never assembles the sequence". It was the latter.
contract HappyPath is Test {
    PersonalWallet w; MockUSDC usdc;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address allowedTo = address(0xD35717);

    function setUp() public {
        usdc = new MockUSDC();
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = allowedTo; rl[0] = "seed";
        address[] memory t = new address[](1); string[] memory tl = new string[](1);
        t[0] = address(usdc); tl[0] = "USDC";
        w = new PersonalWallet([o1,o2,o3], true, true, r, rl, t, tl);
    }

    function test_onePath() public {
        vm.deal(address(this), 100 ether);
        w.depositNative{value: 10 ether}();
        console2.log("balance:", address(w).balance);

        vm.prank(o1);
        uint256 id = w.proposeNative(allowedTo, 1 ether, 1 days);
        console2.log("id:", id);
        console2.log("confirmations after propose:", w.confirmations(id));
        console2.log("required:", w.requiredConfirmations(id));
        console2.log("effectiveAt:", w.effectiveAt(id));
        console2.log("isExecutable:", w.isExecutable(id));

        vm.prank(o2); w.confirm(id);
        console2.log("confirmations after o2:", w.confirmations(id));
        console2.log("isExecutable now:", w.isExecutable(id));

        uint256 before = allowedTo.balance;
        vm.prank(o1);
        w.executeNative(id);
        console2.log("recipient got:", allowedTo.balance - before);
        console2.log("executed OK");
    }

    /// Same, but exactly as the Handler does it — pranking from a contract context.
    function test_viaContractCaller() public {
        vm.deal(address(this), 100 ether);
        w.depositNative{value: 10 ether}();
        vm.prank(o1);
        uint256 id = w.proposeNative(allowedTo, 1 ether, 1 days);
        for (uint256 i; i < 3; i++) {
            address[3] memory os = w.owners();
            vm.prank(os[i]);
            try w.confirm(id) {} catch {}
        }
        console2.log("confirmations:", w.confirmations(id));
        vm.prank(o1);
        try w.executeNative(id) { console2.log("EXECUTED"); }
        catch (bytes memory err) { console2.log("REVERTED, selector:"); console2.logBytes(err); }
    }
}

/**
 * FINDING 1, pinned as an explicit test rather than a permanently red invariant.
 *
 * The exit path is NOT symmetric with the entrance. depositERC20 measures what actually arrived and
 * reverts on zero; executeERC20 calls safeTransfer and emits the INTENDED amount without ever
 * checking that anything moved. A token that returns `true` without transferring therefore gets the
 * proposal marked executed and an ERC20Sent event emitted for value that never left — and every
 * off-chain consumer of those events (our listeners, and the mail they send) is told a lie.
 *
 * This test asserts the behaviour AS IT IS TODAY, so the day somebody fixes it, this breaks loudly
 * and the fix is noticed rather than silently assumed.
 */
contract Finding1_ExitIsNowSymmetric is Test {
    PersonalWallet w; BlackHoleERC20 hole;
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);
    address dest = address(0xD35717);

    function setUp() public {
        hole = new BlackHoleERC20();
        address[] memory r = new address[](1); string[] memory rl = new string[](1);
        r[0] = dest; rl[0] = "dest";
        address[] memory t = new address[](1); string[] memory tl = new string[](1);
        t[0] = address(hole); tl[0] = "HOLE";
        w = new PersonalWallet([o1,o2,o3], true, true, r, rl, t, tl);
    }

    /// FIXED 2026-10-20. Before the fix this SUCCEEDED: the token returned true, nothing moved, the
    /// proposal was consumed and ERC20Sent was emitted for 33 485 that never left. Now the exit
    /// measures what actually left and refuses a no-op, so the whole execute reverts and the
    /// proposal survives for a later, honest attempt.
    function test_lyingTokenCanNoLongerConsumeAProposal() public {
        assertEq(hole.balanceOf(address(w)), 0, "precondition: wallet holds none");

        vm.prank(o1);
        uint256 id = w.proposeERC20(address(hole), dest, 33_485, 20 days);
        vm.prank(o2); w.confirm(id);

        vm.prank(o1);
        vm.expectRevert();                 // ZeroAmount — nothing actually moved
        w.executeERC20(id);

        assertFalse(w.getProposal(id).executed, "proposal NOT consumed");
        assertEq(hole.balanceOf(dest), 0, "recipient still received nothing, but no lie was emitted");
    }

    /// The native path, by contrast, does it right — proof that the gap is specific, not systemic.
    function test_nativePathRefusesWhatItCannotPay() public {
        vm.prank(o1);
        uint256 id = w.proposeNative(dest, 5 ether, 20 days);
        vm.prank(o2); w.confirm(id);
        vm.prank(o1);
        vm.expectRevert();      // InsufficientBalance — it checks before it sends
        w.executeNative(id);
        assertFalse(w.getProposal(id).executed, "nothing consumed");
    }
}
