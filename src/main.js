"use strict";

const { connect, StringCodec } = require("nats");
const mqtt = require("mqtt");
const { createClient } = require("redis");
const cfg = require("./config");

// ─── Redis ────────────────────────────────────────────────────────────────────
async function connectRedis() {
  const client = createClient({ url: cfg.redisUrl });
  client.on("error", (e) => console.error("[Redis] error:", e.message));
  await client.connect();
  console.log("[Redis] Connected");
  return client;
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────
function connectMqtt() {
  const opts = {};
  if (cfg.mqttUser) opts.username = cfg.mqttUser;
  if (cfg.mqttPassword) opts.password = cfg.mqttPassword;

  const client = mqtt.connect(cfg.mqttBroker, {
    ...opts,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });
  client.on("connect", () => console.log("[MQTT] Connected"));
  client.on("error", (e) => console.error("[MQTT] error:", e.message));
  return client;
}

// ─── Device Registry (in-memory + Redis db 2) ─────────────────────────────────
// Key scheme: device:<id> → Hash of state fields
// Key scheme: registry:all_devices → Set of known device IDs
async function registerDevice(redis, announcement) {
  const { id, type, protocol, room, states } = announcement;
  await redis.hSet(`registry:${id}`, {
    type: type ?? "",
    protocol: protocol ?? "",
    room: room ?? "",
    schema: JSON.stringify(states ?? {}),
    last_seen: Date.now(),
  });
  await redis.sAdd("registry:all_devices", id);
  console.log(`[Registry] Device registered: ${id} (${type})`);
}

async function updateDeviceState(redis, deviceId, state) {
  const flat = {};
  for (const [k, v] of Object.entries(state)) flat[k] = String(v);
  flat.last_update = String(Date.now());
  await redis.hSet(`device:${deviceId}`, flat);
  await redis.expire(`device:${deviceId}`, 300); // 5-min TTL
  await redis.sAdd("devices:online", deviceId);
}

// ─── Command Router ───────────────────────────────────────────────────────────
function buildMqttTopic(deviceId, action) {
  // e.g. "mordomo/iot/luz_sala/set" — devices subscribe to mordomo/iot/<id>/set
  return `mordomo/iot/${deviceId}/${action}`;
}

function routeCommand(mqttClient, subject, payload) {
  const parts = subject.split(".");
  // subjects: iot.light.turn_on | iot.switch.turn_on | iot.climate.set_temperature
  //           iot.lock.unlock | iot.lock.lock | iot.sensor.get_state
  const deviceId = payload.device_id;
  if (!deviceId) {
    console.warn(`[Router] Missing device_id in subject: ${subject}`);
    return;
  }

  const action = parts.slice(2).join("_"); // e.g. "turn_on", "set_brightness"
  const mqttTopic = buildMqttTopic(deviceId, action);
  mqttClient.publish(mqttTopic, JSON.stringify(payload), { qos: 1 });
  console.log(`[Router] ${subject} → MQTT ${mqttTopic}`);
}

/**
 * Handle a structured command from mordomo-orchestrator.
 * Subject: mordomo.iot.command
 * Payload: { device_id, command, speaker_id, action_type, [extra params] }
 *
 * Maps payload.command → MQTT action. Examples:
 *   command: "turn_on"   → mordomo/iot/{device_id}/turn_on
 *   command: "turn_off"  → mordomo/iot/{device_id}/turn_off
 *   command: "set"       → mordomo/iot/{device_id}/set (with full payload as MQTT payload)
 */
function routeStructuredCommand(mqttClient, payload) {
  const { device_id, command } = payload;
  if (!device_id || !command) {
    console.warn("[Router] mordomo.iot.command missing device_id or command:", payload);
    return { success: false, error: "missing device_id or command" };
  }

  const mqttTopic = buildMqttTopic(device_id, command);
  // Strip orchestrator meta fields before forwarding
  const { speaker_id, action_type, command_id, __secret, ...mqttPayload } = payload;
  mqttClient.publish(mqttTopic, JSON.stringify(mqttPayload), { qos: 1 });
  console.log(`[Router] mordomo.iot.command → MQTT ${mqttTopic}`);
  return { success: true };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const redis = await connectRedis();
  const mqttClient = connectMqtt();

  // Wait for MQTT to be ready
  await new Promise((resolve) => mqttClient.once("connect", resolve));

  // Subscribe to MQTT discovery topic
  mqttClient.subscribe("iot/discovery", { qos: 1 });
  mqttClient.on("message", async (topic, buf) => {
    try {
      const payload = JSON.parse(buf.toString());
      if (topic === "iot/discovery") {
        await registerDevice(redis, payload);
      } else if (topic.startsWith("iot/") && topic.endsWith("/state")) {
        // Devices report their own state back
        const id = topic.split("/")[1];
        await updateDeviceState(redis, id, payload);
      }
    } catch (e) {
      console.error(`[MQTT] Parse error on ${topic}:`, e.message);
    }
  });

  // Subscribe to device state updates via wildcard
  mqttClient.subscribe("iot/+/state", { qos: 1 });

  // Connect to NATS
  const nc = await connect({ servers: cfg.natsUrl });
  const sc = StringCodec();
  console.log("[NATS] Connected");

  // Subscribe to all iot.* commands
  const iotSub = nc.subscribe("iot.>");
  const lockSub = nc.subscribe("seguranca.access.granted");
  const mordoIotSub = nc.subscribe("mordomo.iot.command");

  (async () => {
    for await (const msg of iotSub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data));
        routeCommand(mqttClient, msg.subject, payload);

        // Publish execution confirmation
        const commandId = payload.command_id ?? `cmd_${Date.now()}`;
        const confirm = {
          command_id: commandId,
          device_id: payload.device_id,
          success: true,
          latency_ms: 0,
        };
        nc.publish("iot.command.executed", sc.encode(JSON.stringify(confirm)));
      } catch (e) {
        console.error(`[NATS] Error processing ${msg.subject}:`, e.message);
      }
    }
  })();

  // Handle face recognition access grants → unlock door
  (async () => {
    for await (const msg of lockSub) {
      try {
        const { device_id, confidence } = JSON.parse(sc.decode(msg.data));
        if (!device_id) return;
        const unlockPayload = {
          device_id,
          requested_by: "face_recognition",
          reason: "access_granted",
          duration_seconds: 10,
          command_id: `cmd_${Date.now()}`,
        };
        routeCommand(mqttClient, "iot.lock.unlock", unlockPayload);
        console.log(`[Access] Door unlocked for ${device_id} (confidence: ${confidence})`);
      } catch (e) {
        console.error("[NATS] Error processing access.granted:", e.message);
      }
    }
  })();

  // Handle structured commands from mordomo-orchestrator
  (async () => {
    for await (const msg of mordoIotSub) {
      const commandId = `cmd_${Date.now()}`;
      try {
        const payload = JSON.parse(sc.decode(msg.data));
        const result = routeStructuredCommand(mqttClient, payload);
        const confirm = {
          command_id: payload.command_id ?? commandId,
          device_id: payload.device_id,
          success: result.success,
          latency_ms: 0,
          ...(result.error ? { error: result.error } : {}),
        };
        nc.publish("iot.command.executed", sc.encode(JSON.stringify(confirm)));
      } catch (e) {
        console.error("[NATS] Error processing mordomo.iot.command:", e.message);
        const payload = JSON.parse(sc.decode(msg.data));
        nc.publish("iot.command.executed", sc.encode(JSON.stringify({
          command_id: commandId,
          device_id: payload?.device_id ?? "unknown",
          success: false,
          error: e.message,
        })));
      }
    }
  })();

  // Graceful shutdown
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      console.log(`[${sig}] Shutting down...`);
      await nc.drain();
      mqttClient.end();
      await redis.quit();
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error("[Fatal]", e);
  process.exit(1);
});
