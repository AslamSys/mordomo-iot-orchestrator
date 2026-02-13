# 🎛️ IoT Orchestrator

## 🔗 Navegação

**[🏠 AslamSys](https://github.com/AslamSys)** → **[📚 _system](https://github.com/AslamSys/_system)** → **[📂 IoT (RPi 3B+)](https://github.com/AslamSys/_system/blob/main/hardware/iot%20-%20(raspberry-pi-3b)/README.md)** → **iot-orchestrator**

### Containers Relacionados (iot)
- [iot-mqtt-broker](https://github.com/AslamSys/iot-mqtt-broker)
- [iot-state-cache](https://github.com/AslamSys/iot-state-cache)

---

**Container:** `iot-orchestrator`  
**Ecossistema:** IoT  
**Hardware:** Raspberry Pi 3B+  
**Sem LLM:** Execução direta de comandos

---

## 📋 Propósito

Orquestrador central de dispositivos IoT. Recebe comandos estruturados via NATS e executa ações diretas em MQTT, Zigbee, BLE e HTTP APIs.

---

## 🎯 Responsabilidades

- ✅ Receber comandos do Mordomo (já interpretados)
- ✅ Rotear para protocolo correto (MQTT/Zigbee/BLE/HTTP)
- ✅ Manter estado de todos dispositivos
- ✅ Executar automações (if-then-else)
- ✅ Heartbeat de dispositivos

---

## 🧠 Camada de Normalização (Protocol Agnostic)

O IoT Orchestrator atua como um **Middleware de Normalização**. O "Cérebro" (Mordomo) nunca deve saber se uma lâmpada é Zigbee, Wi-Fi ou Bluetooth. Ele deve ver apenas um **Objeto Padronizado**.

**Regra de Ouro:**
- **Entrada:** Protocolos sujos (MQTT JSONs variados, Zigbee payloads, BLE bytes).
- **Saída:** Objetos limpos e tipados (Schema Unificado).

---

## 🔍 Auto-Discovery & Schema de Objetos

Inspirado no modelo de "Objects & States" do ioBroker, cada dispositivo deve anunciar não apenas suas capacidades, mas o **contrato exato** de seus estados. Isso permite que o LLM saiba os limites (min/max), unidades e tipos de dados sem adivinhação.

**Tópico MQTT:** `iot/discovery`

### Payload Rico (Novo Padrão)

```json
{
  "id": "luz_sala_principal",
  "name": "Luz Principal da Sala",
  "type": "light",      // light, switch, sensor, cover, climate
  "protocol": "wifi",   // Apenas informativo (wifi, zigbee, ble)
  "room": "sala",
  
  // Definição exata dos canais de controle (States)
  "states": {
    "power": {
      "type": "boolean",
      "role": "switch.power",
      "read": true,
      "write": true,
      "desc": "Estado Ligado/Desligado"
    },
    "brightness": {
      "type": "number",
      "role": "level.dimmer",
      "min": 0,
      "max": 100,
      "unit": "%",
      "read": true,
      "write": true,
      "desc": "Intensidade do brilho"
    },
    "color_temp": {
      "type": "number",
      "role": "level.color.temperature",
      "min": 2700,
      "max": 6500,
      "unit": "K",
      "read": true,
      "write": true,
      "desc": "Temperatura de cor (Kelvin)"
    },
    "consumption": {
      "type": "number",
      "role": "value.power.consumption",
      "unit": "W",
      "read": true,
      "write": false,
      "desc": "Consumo atual em Watts"
    }
  }
}
```

### Vantagens para o LLM
Com esse schema, o LLM não precisa "alucinar" se o brilho é 0-1 ou 0-255.

LLM pergunta: "Quais os controles da luz_sala_principal?"
Sistema responde: "Brightness (0-100%), Color Temp (2700-6500K)".
LLM gera ação precisa: `set_state("luz_sala_principal", "brightness", 50)`.

---

## 🔌 NATS Topics

### Subscribe
```javascript
// Controle de luz
Topic: "iot.light.turn_on|turn_off|set_brightness|set_color"
Payload: {
  "device_id": "luz_sala",
  "brightness": 80,  // 0-100
  "color": {"r": 255, "g": 200, "b": 150}
}

// Controle de tomada
Topic: "iot.switch.turn_on|turn_off"
Payload: {"device_id": "tomada_tv"}

// Controle de termostato
Topic: "iot.climate.set_temperature"
Payload: {"device_id": "ac_sala", "temperature": 22}

// Sensor query
Topic: "iot.sensor.get_state"
Payload: {"device_id": "sensor_temperatura_quarto"}
```

### Publish
```javascript
// Confirmação de comando
Topic: "iot.command.executed"
Payload: {
  "command_id": "cmd_123",
  "device_id": "luz_sala",
  "success": true,
  "latency_ms": 45
}

// Atualização de sensor
Topic: "iot.sensor.update"
Payload: {
  "device_id": "sensor_temperatura",
  "state": {"temperature": 23.5, "humidity": 65},
  "timestamp": 1732723200.123
}
```

---

## 🚀 Docker

```yaml
iot-orchestrator:
  build: ./iot-orchestrator
  environment:
    - NATS_URL=nats://mordomo-nats:4222
    - MQTT_BROKER=mqtt://mqtt-broker:1883
    - DEVICE_DB=/data/devices.json
  volumes:
    - ./data:/data
  networks:
    - iot-net
    - shared-nats
  deploy:
    resources:
      limits:
        cpus: '0.6'
        memory: 384M
```

---

## 🧪 Código

```javascript
const { connect } = require('nats');
const mqtt = require('mqtt');

const nc = await connect({ servers: process.env.NATS_URL });
const mqttClient = mqtt.connect(process.env.MQTT_BROKER);

// Subscribe to IoT commands
const sub = nc.subscribe('iot.light.turn_on');
for await (const msg of sub) {
    const cmd = JSON.parse(sc.decode(msg.data));
    
    // Execute via MQTT (direct, no LLM)
    mqttClient.publish(
        `zigbee2mqtt/${cmd.device_id}/set`,
        JSON.stringify({ state: 'ON', brightness: cmd.brightness * 2.55 })
    );
    
    // Confirm
    nc.publish('iot.command.executed', sc.encode(JSON.stringify({
        command_id: cmd.command_id,
        device_id: cmd.device_id,
        success: true,
        latency_ms: Date.now() - cmd.timestamp
    })));
}
```

---

## 📊 Supported Protocols

```yaml
MQTT: Devices via zigbee2mqtt, tasmota
Zigbee: Lights, switches, sensors
BLE: Bluetooth locks, thermometers
HTTP: Smart plugs, cameras APIs
```

---

## 🔄 Changelog

### v1.0.0
- ✅ NATS → MQTT/Zigbee router
- ✅ Direct command execution (no LLM)
- ✅ Device state management
- ✅ < 100ms latency
