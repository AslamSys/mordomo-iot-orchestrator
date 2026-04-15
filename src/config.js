module.exports = {
  natsUrl: process.env.NATS_URL || "nats://localhost:4222",
  mqttBroker: process.env.MQTT_BROKER || "mqtt://localhost:1883",
  mqttUser: process.env.MQTT_USER || "",
  mqttPassword: process.env.MQTT_PASSWORD || "",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379/2",
  logLevel: process.env.LOG_LEVEL || "info",
};
