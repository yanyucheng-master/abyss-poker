/**
 * Two-client online sync smoke test: create -> password -> join fail/success -> start
 */
const { io } = require("socket.io-client");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connect(name) {
  const socket = io(BASE, { transports: ["websocket"], forceNew: true });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error(`connect timeout ${name}`)), 5000);
  });
}

async function main() {
  const host = await connect("host");
  const guest = await connect("guest");
  const results = [];

  host.emit("create_room", {
    playerName: "Host",
    playerId: "PHOSTSYNC",
    gameMode: "standard",
    skillMode: "off",
    password: null,
  });
  const created = await once(host, "room_created");
  const hostJoined = await once(host, "room_joined");
  results.push({
    step: "create",
    roomId: created.roomId,
    phase: hostJoined.phase,
    hasPassword: hostJoined.hasPassword,
  });
  if (hostJoined.phase !== "waiting") throw new Error("host join phase should be waiting");
  if (hostJoined.hasPassword) throw new Error("new room should have no password");

  host.emit("room:set_password", { password: "secret1" });
  const pwdUpdated = await once(host, "room:password_updated");
  const hostState = await once(host, "room_state");
  results.push({
    step: "set_password",
    hasPasswordEvent: pwdUpdated.hasPassword,
    hasPasswordState: hostState.hasPassword,
  });
  if (!pwdUpdated.hasPassword || !hostState.hasPassword) throw new Error("password not synced");

  guest.emit("join_room", {
    roomId: created.roomId,
    playerName: "Guest",
    playerId: "PGUESTSYNC",
    password: null,
  });
  const joinErr = await once(guest, "join_error");
  results.push({ step: "join_without_password", code: joinErr.code, message: joinErr.message });
  if (joinErr.code !== "PASSWORD_REQUIRED") throw new Error("expected PASSWORD_REQUIRED");

  guest.emit("join_room", {
    roomId: created.roomId,
    playerName: "Guest",
    playerId: "PGUESTSYNC",
    password: "secret1",
  });
  const [guestJoined, hostSawGuest, hostRoomState] = await Promise.all([
    once(guest, "room_joined"),
    once(host, "player_joined"),
    once(host, "room_state"),
  ]);
  results.push({
    step: "join_with_password",
    guestPlayers: guestJoined.players?.length,
    hostPlayers: hostSawGuest.players?.length,
    hostStatePlayers: hostRoomState.players?.length,
    guestPhase: guestJoined.phase,
  });
  if (guestJoined.players.length !== 2) throw new Error("guest should see 2 players");
  if (hostSawGuest.players.length !== 2) throw new Error("host player_joined should include 2 players");
  if (hostRoomState.players.length !== 2) throw new Error("host room_state should include 2 players");

  host.disconnect();
  guest.disconnect();
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
