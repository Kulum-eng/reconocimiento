import express from "express";
import { RekognitionClient, CompareFacesCommand } from "@aws-sdk/client-rekognition";
import fs from "fs";
import amqp from "amqplib";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config(); // Cargar las variables de entorno desde el archivo .env

const app = express();
const port = 3200;

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const NOTIFICATION_QUEUE = process.env.NOTIFICATION_QUEUE;
let rabbitChannel;

const ESP32_IP = process.env.ESP32_IP;

const client = new RekognitionClient({
    region: "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
    },
});

async function connectToRabbitMQ() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        rabbitChannel = await connection.createChannel();
        await rabbitChannel.assertQueue(NOTIFICATION_QUEUE, { durable: true });
        console.log('✅ Conexión a RabbitMQ establecida - Cola "notificaciones" lista');
    } catch (error) {
        console.error('❌ Error conectando a RabbitMQ:', error.message);
        setTimeout(connectToRabbitMQ, 5000);
    }
}

connectToRabbitMQ();

app.use(express.json({ limit: '10mb' }));

async function activarAlarma() {
    try {
        const response = await fetch(`${ESP32_IP}/alarma`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();
        console.log("🚨 Alarma activada:", data);
    } catch (error) {
        console.error("❌ Error activando la alarma:", error);
    }
}

async function abrirPuerta() {
    try {
        const response = await fetch(`${ESP32_IP}/abrir_puerta`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();
        console.log("🔓 Puerta abierta:", data);
    } catch (error) {
        console.error("❌ Error abriendo la puerta:", error);
    }
}

async function enviarNotificacion(token, message) {
    if (rabbitChannel) {
        const msg = JSON.stringify({ token, message });
        rabbitChannel.sendToQueue(NOTIFICATION_QUEUE, Buffer.from(msg));
        console.log('📨 Notificación enviada a RabbitMQ:', { token, message });
    } else {
        console.error('❌ Canal RabbitMQ no disponible');
    }
}

app.post("/compare", async (req, res) => {
    const { base64, token } = req.body;

    if (!base64) {
        return res.status(400).json({ error: "Se requiere una imagen en base64" });
    }

    const targetImagePath = "target.jpg";
    const targetImage = fs.readFileSync(targetImagePath);

    const sourceImageBuffer = Buffer.from(base64, 'base64');

    const params = {
        SourceImage: { Bytes: sourceImageBuffer },
        TargetImage: { Bytes: targetImage },
        SimilarityThreshold: 80,
    };

    try {
        const command = new CompareFacesCommand(params);
        const response = await client.send(command);

        const match = response.FaceMatches.length > 0;
        const similarity = response.FaceMatches[0]?.Similarity || 0;

        if (match) {
            console.log("✅ Rostro válido. Abriendo puerta...");
            abrirPuerta();
            enviarNotificacion(token, "Puerta abierta");
        } else {
            console.log("❌ Rostro no reconocido. Activando alarma...");
            activarAlarma();
            enviarNotificacion(token, "Alarma activada");
        }

        return res.json({ match, similarity });

    } catch (error) {
        console.error("❌ Error al comparar rostros:", error);
        return res.status(500).json({ error: true, message: error.message });
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});

process.on('SIGINT', async () => {
    console.log('\n🔴 Deteniendo servidor...');
    if (rabbitChannel) await rabbitChannel.close();
    process.exit(0);
});
