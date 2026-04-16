# 🎛️ IoT Orchestrator

## 🔗 Navegação

**[🏠 AslamSys](https://github.com/AslamSys)** → **[📚 _system](https://github.com/AslamSys/_system)** → **[📂 IoT](https://github.com/AslamSys/mordomo/blob/main/iot)/README.md)** → **iot-orchestrator**

### Containers Relacionados (iot)
- [iot-mqtt-broker](https://github.com/AslamSys/iot-mqtt-broker)
- [infra/redis](https://github.com/AslamSys/infra) — db 2 (iot-state)

---

**Container:** `iot-orchestrator`  
**Ecossistema:** IoT  
**Hardware:** Orange Pi 5 Ultra  
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
// ── Comandos do Mordomo (orchestrator) ────────────────────
// Formato estruturado: device_id + command no payload
Topic: "mordomo.iot.command"
Payload: {
  "speaker_id":  "user_1",
  "action_type": "iot_control",
  "device_id":   "luz_sala",
  "command":     "turn_on",     // turn_on | turn_off | set | toggle
  "brightness":  80,            // parâmetros extras opcionais
  "command_id":  "cmd_abc123"
}

// ── Fechaduras ─────────────────────────────────────────────
// Abrir por reconhecimento facial (publicado pelo seguranca-face-recognition)
Topic: "seguranca.access.granted"
Payload: {
  "identity_id": "joao",
  "display_name": "João",
  "zone": "porta_entrada",
  "device_id": "fechadura_entrada",
  "confidence": 0.97,
  "timestamp": "2026-04-13T08:30:00Z"
}

// Abrir por comando explícito do Mordomo (WhatsApp, voz, dashboard)
// Ignora face recognition — o usuário autorizou manualmente
Topic: "iot.lock.unlock"
Payload: {
  "device_id": "fechadura_entrada",    // ou "fechadura_garagem"
  "requested_by": "mordomo",           // identifica a origem do comando
  "reason": "user_command",            // "user_command" | "access_granted" | "schedule"
  "duration_seconds": 10,             // quanto tempo fica destravada (0 = toggle)
  "command_id": "cmd_abc123"
}

// Travar explicitamente
Topic: "iot.lock.lock"
Payload: { "device_id": "fechadura_entrada", "command_id": "cmd_abc124" }

// ── Controle de luz ────────────────────────────────────────
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
## 🔐 Controle de Acesso por Trust Level (NATS)

Nem todos os serviços têm permissão para publicar em todos os tópicos IoT. Fechaduras requerem **trust elevado** — apenas usuários NATS explicitamente autorizados podem emitir comandos de lock/unlock.

```
Trust Nível 1 (qualquer serviço IoT):  iot.device.control.>  — luzes, tomadas, AC
Trust Nível 2 (só mordomo-brain):      iot.lock.>            — fechaduras físicas
Trust Nível 2 (só seguranca):          seguranca.access.granted → iot-orchestrator traduz
```

| Usuário NATS | `iot.device.control.>` | `iot.lock.>` |
|---|---|---|
| `mordomo-brain` | ✅ | ✅ |
| `seguranca-face-recognition` | ✅ | 🚫 publica `seguranca.access.granted` → orchestrator converte |
| `openclaw` | ✅ | 🚫 |

> **Por que `seguranca-face-recognition` não publica direto em `iot.lock.*`?** Porque segurança decide, IoT executa — separação de responsabilidades. O `iot-orchestrator` é o único que fala MQTT.

---
## � Controle de Fechadura — Prioridade de Comandos

A fechadura pode ser acionada por três origens distintas, com prioridade explícita:

| Prioridade | Origem | Topic NATS | Bypass face? |
|---|---|---|---|
| 1 (mais alta) | Comando Mordomo (voz/WhatsApp/dashboard) | `iot.lock.unlock` | ✅ Sim |
| 2 | Reconhecimento facial autorizado | `seguranca.access.granted` | — |
| 3 | Programação de horário | `iot.schedule.trigger` | ✅ Sim |

**Caso de uso típico:** Usuário pede via WhatsApp *"abre o portão pra fulano"* → `mordomo-brain` interpreta → publica `iot.lock.unlock` → portão abre, independente da câmera ou face recognition.

### Mapeamento dispositivo → MQTT
```yaml
# config/locks.yaml
locks:
  fechadura_entrada:
    mqtt_topic: "home/locks/entrada/set"
    mqtt_payload_unlock: '{"state": "UNLOCK"}'
    mqtt_payload_lock:   '{"state": "LOCK"}'
    auto_lock_seconds: 10    # retrava automaticamente após N segundos
  fechadura_garagem:
    mqtt_topic: "home/locks/garagem/set"
    mqtt_payload_unlock: '{"state": "UNLOCK"}'
    mqtt_payload_lock:   '{"state": "LOCK"}'
    auto_lock_seconds: 30
```

---

## 🔄 Changelog

### v1.0.0
- ✅ NATS → MQTT/Zigbee router
- ✅ Direct command execution (no LLM)
- ✅ Device state management
- ✅ < 100ms latency
- ✅ Door lock control (face recognition + Mordomo override)
