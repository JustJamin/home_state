// One-touch deploy: put a profile (app + version + config script) onto a node.
//   1. identify the node (device.info over JSON-RPC; INFO for pre-RPC firmware)
//   2. flash the profile's firmware if the node runs a different version
//   3. optionally set the board ID (per node, never part of the shared config)
//   4. run the config script call by call, reconnecting after a reboot
//   5. record the deployment (store + outbox) for the fleet record
// Everything it needs is passed in, so it runs the same against a real node or a mock.

import { flash as otaFlash, reconnectInfo } from "./ota.js";
import { addRecord } from "./store.js";

export class DeployError extends Error {}

const now = () => new Date().toISOString();

export async function deploy({
  node, profile, catalogue, store, boardId = null, client = "provision",
  log = () => {}, progress = () => {},
  flashFn = otaFlash, reconnectFn = reconnectInfo,
}) {
  const rec = {
    id: crypto.randomUUID(), device_id: null, board_id: null, profile_id: profile.id, profile_name: profile.name,
    app: profile.app, version: profile.version, from_version: null, flashed: false,
    rf_stack: profile.rf_stack ?? null, ble_address: null,
    script: profile.script, results: [], ok: false, error: null, started_at: now(), finished_at: null, client,
  };
  const methods = await catalogue.json(profile.app, profile.version, "methods.json");

  async function identify() {
    if (node.rpc) {
      const i = await node.rpc.call("device.info");
      return { app: i.app, version: i.version, device_id: i.device_id, board_id: i.board_id, ble_address: i.ble_address ?? null };
    }
    const i = await node.readInfo(); // pre-RPC firmware: no device ID
    return { app: i.proj, version: i.fw, device_id: null, board_id: i.board, ble_address: null };
  }

  async function reconnect(why) {
    log(`waiting for the node to come back (${why})…`);
    const info = await reconnectFn(node, { onLog: log });
    return info;
  }

  try {
    progress({ step: "identify" });
    let who = await identify();
    rec.from_version = who.version;
    rec.device_id = who.device_id;
    rec.board_id = who.board_id;
    rec.ble_address = who.ble_address;
    log(`node: ${who.app} ${who.version}${who.device_id ? `, device ${who.device_id}` : ""}, board ${who.board_id}`);
    if (who.app !== profile.app) {
      throw new DeployError(`node runs ${who.app}, but the profile is for ${profile.app}`);
    }

    if (who.version !== profile.version) {
      progress({ step: "flash" });
      log(`flashing ${profile.app} ${profile.version} (node has ${who.version})`);
      const image = await catalogue.firmware(profile.app, profile.version);
      await flashFn(node, image, { onLog: log, onProgress: p => progress({ step: "flash", ...p }) });
      rec.flashed = true;
      const info = await reconnect("reboot into new firmware");
      if (info.fw !== profile.version) {
        throw new DeployError(`node came back on ${info.fw}${info.rolled_back_from ? ` (rolled back from ${info.rolled_back_from})` : ""}`);
      }
      who = await identify();
      rec.device_id = who.device_id;
      rec.board_id = who.board_id;
      rec.ble_address = who.ble_address;
    }

    if (!node.rpc) throw new DeployError(`${who.version} has no JSON-RPC, so the config can't be applied`);

    if (boardId != null && boardId !== who.board_id) {
      progress({ step: "board" });
      const r = await node.rpc.call("board.set_id", { id: boardId });
      rec.results.push({ method: "board.set_id", ok: true, result: r });
      rec.board_id = r.board_id;
      log(`board ID set to ${r.board_id}`);
    }

    progress({ step: "config" });
    for (const [i, call] of profile.script.calls.entries()) {
      log(`call ${i + 1}/${profile.script.calls.length}: ${call.method}`);
      try {
        const result = await node.rpc.call(call.method, call.params);
        rec.results.push({ method: call.method, ok: true, result });
      } catch (e) {
        rec.results.push({ method: call.method, ok: false, error: e.message, code: e.code ?? null });
        throw new DeployError(`call ${i + 1} (${call.method}) failed: ${e.message}`);
      }
      if (methods.methods?.[call.method]?.reboots) {
        await reconnect(call.method);
        if (!node.rpc) throw new DeployError("node came back without JSON-RPC");
      }
    }
    rec.ok = true;
    log("deploy complete");
  } catch (e) {
    rec.error = e.message;
    log(`FAILED: ${e.message}`);
  } finally {
    rec.finished_at = now();
    if (rec.device_id) {
      await addRecord(store, "deployments", rec);
    } else {
      log("not recorded: the node never reported a device ID (pre-RPC firmware and the flash failed)");
    }
    progress({ step: "done", ok: rec.ok });
  }
  return rec;
}
