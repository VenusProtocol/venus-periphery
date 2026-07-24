// Fork helpers for driving the REAL deployed Lista StakeManager through states that,
// on mainnet, only its off-chain bot can reach (beacon-chain undelegation + confirmation).
//
// Both helpers locate the storage slot they need empirically and VERIFY the result through
// the contract's own getter (`nextConfirmedRequestUUID()` / `hasRole`). A wrong slot is
// reverted and the scan continues, so a layout change fails loudly instead of silently
// mutating unrelated storage and testing nothing.
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { BigNumber } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";

import { LISTA_STAKE_MANAGER } from "./constants";

// Real Lista StakeManager surface used by the tests (read paths + the bot claim).
export const LISTA_MANAGER_ABI = [
  "function nextConfirmedRequestUUID() view returns (uint256)",
  "function requestUUID() view returns (uint256)",
  "function paused() view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getUserWithdrawalRequests(address user) view returns (tuple(uint256 uuid, uint256 amountInSnBnb, uint256 startTime)[])",
  "function getUserRequestStatus(address user, uint256 idx) view returns (bool isClaimable, uint256 amount)",
  "function claimWithdrawFor(address user, uint256 idx) external",
];

// keccak256("BOT") — the role Lista requires for claimWithdrawFor.
const BOT_ROLE = ethers.utils.id("BOT");

// Upper bound for the slot scans. Lista's custom state sits ~slot 200 and AccessControl's
// `_roles` ~slot 100 behind the OZ upgradeable base gaps; 512 is comfortable headroom.
const MAX_SLOT_SCAN = 512;

export async function getListaManager() {
  return ethers.getContractAt(LISTA_MANAGER_ABI, LISTA_STAKE_MANAGER);
}

/**
 * Make a freshly-created Lista request claimable on the fork.
 *
 * On mainnet `nextConfirmedRequestUUID` only advances inside `claimUndelegated` (BOT-only,
 * after real beacon-chain unbonding). We instead write the pointer directly: scan for the
 * slot, set it to `uuid + 1`, and confirm via the public getter. We also top up the
 * StakeManager's native balance so the subsequent payout is deterministic regardless of
 * how much pooled BNB the fork block happens to hold (on mainnet the BNB is genuinely there).
 */
export async function forceConfirmListaRequest(uuid: BigNumber): Promise<void> {
  const lista = await getListaManager();
  const target = uuid.add(1); // request claimable once uuid < nextConfirmedRequestUUID
  const current: BigNumber = await lista.nextConfirmedRequestUUID();

  if (current.lt(target)) {
    const targetHex = ethers.utils.hexZeroPad(target.toHexString(), 32);
    let located = false;

    for (let slot = 0; slot < MAX_SLOT_SCAN; slot++) {
      const raw = await ethers.provider.getStorageAt(LISTA_STAKE_MANAGER, slot);
      // Only the pointer's own slot currently holds `current`; fingerprint on that value.
      if (!BigNumber.from(raw).eq(current)) continue;

      const slotHex = ethers.utils.hexZeroPad(BigNumber.from(slot).toHexString(), 32);
      await ethers.provider.send("hardhat_setStorageAt", [LISTA_STAKE_MANAGER, slotHex, targetHex]);

      if ((await lista.nextConfirmedRequestUUID()).eq(target)) {
        located = true;
        break;
      }
      // Wrong slot: undo and keep scanning.
      await ethers.provider.send("hardhat_setStorageAt", [LISTA_STAKE_MANAGER, slotHex, raw]);
    }

    if (!located) {
      throw new Error("forceConfirmListaRequest: could not locate nextConfirmedRequestUUID slot");
    }
  }

  const balance = await ethers.provider.getBalance(LISTA_STAKE_MANAGER);
  await setBalance(LISTA_STAKE_MANAGER, balance.add(parseUnits("10000", 18)));
}

/**
 * Grant Lista's BOT role to `account` on the fork by writing `_roles[BOT].members[account]`.
 *
 * AccessControlUpgradeable lays out `RoleData { mapping(address=>bool) members; bytes32 adminRole; }`
 * with `members` at offset 0, so the members mapping base == the RoleData slot. We scan the base
 * slot of the `_roles` mapping, set the membership bit, and confirm via `hasRole`. Only the
 * address-specific membership sub-slot is ever touched (and restored on a miss), so no unrelated
 * state is corrupted.
 */
export async function forceGrantListaBot(account: string): Promise<void> {
  const lista = await getListaManager();
  if (await lista.hasRole(BOT_ROLE, account)) return;

  const coder = ethers.utils.defaultAbiCoder;
  const ONE = ethers.utils.hexZeroPad("0x01", 32);

  for (let rolesSlot = 0; rolesSlot < MAX_SLOT_SCAN; rolesSlot++) {
    const roleDataSlot = ethers.utils.keccak256(coder.encode(["bytes32", "uint256"], [BOT_ROLE, rolesSlot]));
    const membersSlot = ethers.utils.keccak256(coder.encode(["address", "uint256"], [account, roleDataSlot]));

    const prev = await ethers.provider.getStorageAt(LISTA_STAKE_MANAGER, membersSlot);
    await ethers.provider.send("hardhat_setStorageAt", [LISTA_STAKE_MANAGER, membersSlot, ONE]);

    if (await lista.hasRole(BOT_ROLE, account)) return;

    await ethers.provider.send("hardhat_setStorageAt", [LISTA_STAKE_MANAGER, membersSlot, prev]);
  }

  throw new Error("forceGrantListaBot: could not locate AccessControl _roles slot");
}
