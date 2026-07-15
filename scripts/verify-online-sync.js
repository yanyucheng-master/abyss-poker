/**
 * Two-client online sync smoke test:
 * create -> password -> join fail/success -> abyss loadout -> reconnect roomId
 */
const { io } = require("socket.io-client");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";
const activeSockets = new Set();

const LOADOUT_A = ["ABYSS_BREATH", "EMBER_RECYCLE", "ECHO_SCAN", "SILENCE_ZONE"];
const LOADOUT_B = ["ADVERSITY_CIRCUIT", "PROBABILITY_CLOAK", "OVERLOAD_CORE", "EMBER_RECYCLE"];

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
    const timer = setTimeout(() => reject(new Error(`connect timeout ${name}`)), 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      activeSockets.add(socket);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const sockets = [];
  const host = await connect("host");
  sockets.push(host);
  const guest = await connect("guest");
  sockets.push(guest);
  const results = [];

  const createdPromise = once(host, "room_created");
  const hostJoinedPromise = once(host, "room_joined");
  host.emit("create_room", {
    playerName: "Host",
    playerId: "PHOSTSYNC",
    gameMode: "standard",
    skillMode: "off",
    password: null,
  });
  const [created, hostJoined] = await Promise.all([createdPromise, hostJoinedPromise]);
  results.push({
    step: "create",
    roomId: created.roomId,
    phase: hostJoined.phase,
    hasPassword: hostJoined.hasPassword,
    joinedRoomId: hostJoined.roomId,
  });
  if (!created.roomId || created.roomId !== hostJoined.roomId) {
    throw new Error("room_created/room_joined roomId mismatch");
  }
  if (hostJoined.phase !== "waiting") throw new Error("host join phase should be waiting");
  if (hostJoined.hasPassword) throw new Error("new room should have no password");

  const pwdUpdatedPromise = once(host, "room:password_updated");
  const hostStatePromise = once(host, "room_state");
  host.emit("room:set_password", { password: "secret1" });
  const [pwdUpdated, hostState] = await Promise.all([pwdUpdatedPromise, hostStatePromise]);
  results.push({
    step: "set_password",
    hasPasswordEvent: pwdUpdated.hasPassword,
    eventRoomId: pwdUpdated.roomId,
    hasPasswordState: hostState.hasPassword,
    stateRoomId: hostState.roomId,
  });
  if (!pwdUpdated.hasPassword || !hostState.hasPassword) throw new Error("password not synced");
  if (pwdUpdated.roomId !== created.roomId) throw new Error("password_updated missing/wrong roomId");
  if (hostState.roomId !== created.roomId) throw new Error("room_state missing/wrong roomId");

  const joinErrorPromise = once(guest, "join_error");
  guest.emit("join_room", {
    roomId: created.roomId,
    playerName: "Guest",
    playerId: "PGUESTSYNC",
    password: null,
  });
  const joinErr = await joinErrorPromise;
  results.push({ step: "join_without_password", code: joinErr.code, message: joinErr.message });
  if (joinErr.code !== "PASSWORD_REQUIRED") throw new Error("expected PASSWORD_REQUIRED");

  const successfulJoinPromises = [
    once(guest, "room_joined"),
    once(host, "player_joined"),
    once(host, "room_state"),
  ];
  guest.emit("join_room", {
    roomId: created.roomId,
    playerName: "Guest",
    playerId: "PGUESTSYNC",
    password: "secret1",
  });
  const [guestJoined, hostSawGuest, hostRoomState] = await Promise.all(successfulJoinPromises);
  results.push({
    step: "join_with_password",
    guestPlayers: guestJoined.players?.length,
    hostPlayers: hostSawGuest.players?.length,
    hostStatePlayers: hostRoomState.players?.length,
    guestPhase: guestJoined.phase,
    guestRoomId: guestJoined.roomId,
    hostStateRoomId: hostRoomState.roomId,
  });
  if (guestJoined.players.length !== 2) throw new Error("guest should see 2 players");
  if (hostSawGuest.players.length !== 2) throw new Error("host player_joined should include 2 players");
  if (hostRoomState.players.length !== 2) throw new Error("host room_state should include 2 players");
  if (guestJoined.roomId !== created.roomId) throw new Error("guest room_joined wrong roomId");
  if (hostRoomState.roomId !== created.roomId) throw new Error("host room_state wrong roomId after join");

  host.disconnect();
  guest.disconnect();

  // Abyss skill loadout two-player sync
  const abyssHost = await connect("abyss-host");
  sockets.push(abyssHost);
  const abyssGuest = await connect("abyss-guest");
  sockets.push(abyssGuest);
  const abyssCreatedPromise = once(abyssHost, "room_created");
  const abyssHostJoinedPromise = once(abyssHost, "room_joined");
  abyssHost.emit("create_room", {
    playerName: "AbyssHost",
    playerId: "PABYSSHOST",
    gameMode: "standard",
    skillMode: "abyss",
    password: null,
  });
  const [abyssCreated, abyssHostJoined] = await Promise.all([
    abyssCreatedPromise,
    abyssHostJoinedPromise,
  ]);
  if (abyssHostJoined.skillMode !== "abyss") throw new Error("abyss room skillMode mismatch");
  if (!Array.isArray(abyssHostJoined.skillCatalog) || abyssHostJoined.skillCatalog.length < 4) {
    throw new Error("abyss host should receive skillCatalog");
  }

  const abyssGuestJoinedPromise = once(abyssGuest, "room_joined");
  abyssGuest.emit("join_room", {
    roomId: abyssCreated.roomId,
    playerName: "AbyssGuest",
    playerId: "PABYSSGUEST",
    password: null,
  });
  const abyssGuestJoined = await abyssGuestJoinedPromise;
  if (abyssGuestJoined.players.length !== 2) throw new Error("abyss guest should see 2 players");

  function onceLoadout(socket, playerId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout loadout ${playerId}`)), 5000);
      const handler = (payload) => {
        if (payload?.playerId !== playerId) return;
        clearTimeout(timer);
        socket.off("skill:loadout:confirmed", handler);
        resolve(payload);
      };
      socket.on("skill:loadout:confirmed", handler);
    });
  }

  const hostConfirmP = onceLoadout(abyssHost, abyssHostJoined.playerId);
  abyssHost.emit("skill:loadout:set", { skillIds: LOADOUT_A });
  const hostConfirm = await hostConfirmP;
  if (hostConfirm.roomId !== abyssCreated.roomId) {
    throw new Error("loadout confirm roomId mismatch for host");
  }

  const guestConfirmP = onceLoadout(abyssGuest, abyssGuestJoined.playerId);
  const hostSeesGuestP = onceLoadout(abyssHost, abyssGuestJoined.playerId);
  abyssGuest.emit("skill:loadout:set", { skillIds: LOADOUT_B });
  const [guestConfirm, hostSeesGuest] = await Promise.all([guestConfirmP, hostSeesGuestP]);
  if (guestConfirm.roomId !== abyssCreated.roomId || hostSeesGuest.roomId !== abyssCreated.roomId) {
    throw new Error("guest loadout confirm roomId mismatch");
  }
  results.push({
    step: "abyss_loadout",
    roomId: abyssCreated.roomId,
    hostConfirmPlayerId: hostConfirm.playerId,
    guestConfirmPlayerId: guestConfirm.playerId,
    hostSawGuestConfirm: hostSeesGuest.playerId,
    catalogSize: abyssHostJoined.skillCatalog.length,
  });

  // Reconnect: guest reconnect token path
  const token = abyssGuestJoined.reconnectToken;
  const guestId = abyssGuestJoined.playerId;
  abyssGuest.disconnect();
  const guest2 = await connect("abyss-guest-re");
  sockets.push(guest2);
  const reJoinedPromise = once(guest2, "room_joined");
  guest2.emit("join_room", {
    roomId: abyssCreated.roomId,
    playerName: "AbyssGuest",
    playerId: guestId,
    reconnectToken: token,
    password: null,
  });
  const reJoined = await reJoinedPromise;
  if (reJoined.roomId !== abyssCreated.roomId) throw new Error("reconnect roomId mismatch");
  if (reJoined.players.length !== 2) throw new Error("reconnect should keep 2 players");
  results.push({
    step: "reconnect",
    roomId: reJoined.roomId,
    players: reJoined.players.length,
    playerId: reJoined.playerId,
  });

  abyssHost.disconnect();
  guest2.disconnect();
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  activeSockets.forEach((socket) => socket.disconnect());
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
