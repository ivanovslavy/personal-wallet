// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test, console2} from "forge-std/Test.sol";
import {PersonalWallet} from "../contracts/PersonalWallet.sol";

/// At what registry size does allowedTokens() stop being callable? The lists only grow — a revoked
/// entry keeps its slot so its label and history survive — and the view walks the whole thing.
/// This is an off-chain read, so the ceiling is not the block gas limit but the node's eth_call cap,
/// typically 50M on a public RPC and 10M on a stingy one.
contract RegistryGas is Test {
    address o1 = address(0xA11CE); address o2 = address(0xB0B); address o3 = address(0xCA401);

    function _build(uint256 n) internal returns (PersonalWallet w) {
        address[] memory t = new address[](n);
        string[] memory tl = new string[](n);
        for (uint256 i; i < n; i++) {
            t[i] = address(uint160(0x10000 + i));
            tl[i] = "USD Coin (Circle)";          // a realistic label length
        }
        address[] memory r = new address[](0);
        string[] memory rl = new string[](0);
        w = new PersonalWallet([o1,o2,o3], false, true, r, rl, t, tl);
    }

    function test_viewGasByRegistrySize() public {
        uint256[6] memory sizes = [uint256(10), 50, 100, 250, 500, 1000];
        for (uint256 k; k < 6; k++) {
            PersonalWallet w = _build(sizes[k]);
            uint256 g0 = gasleft();
            w.allowedTokens();
            uint256 used = g0 - gasleft();
            console2.log("tokens:", sizes[k]);
            console2.log("   allowedTokens() gas:", used);
            console2.log("   per entry          :", used / sizes[k]);
        }
    }
}
