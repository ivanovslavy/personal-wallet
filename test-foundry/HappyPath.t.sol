// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";
import {MockUSDC} from "../contracts/mocks/TestTokens.sol";

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
