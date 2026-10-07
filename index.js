const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const fetch = require("node-fetch");

// NUEVO: Importar Firebase para Node.js
const { initializeApp } = require("firebase/app");
const { getFirestore, collection, addDoc } = require("firebase/firestore");


// Configuración de tu Firebase
const firebaseConfig = {
    apiKey: "AIzaSyCSdcopQjbZoYwcgwjB8uhosN-yY11kMdQ",
    authDomain: "tienda-kruger.firebaseapp.com",
    projectId: "tienda-kruger",
    storageBucket: "tienda-kruger.firebasestorage.app",
    messagingSenderId: "675310203131",
    appId: "1:675310203131:web:aaec21767633143169805e"
};
const appFirebase = initializeApp(firebaseConfig);
const db = getFirestore(appFirebase);

// Configurar el "cartero" de Gmail
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'krugerdistribudorautorizado@gmail.com',
        pass: process.env.EMAIL_PASS
    }
});

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// =================================================================
// RUTA 1: CREAR EL LINK DE PAGO CLIP
// =================================================================
app.post("/crear-pago-clip", async (req, res) => {
    try {
        const { items, total, ordenKruger } = req.body;
        const apiKey = process.env.CLIP_API_KEY;
        const secretKey = process.env.CLIP_SECRET_KEY;
        const tokenBase64 = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

        const response = await fetch('https://api.payclip.com/v2/checkout', {
            method: 'POST',
            headers: {
                'accept': 'application/vnd.clip.v2+json',
                'content-type': 'application/json',
                'Authorization': `Basic ${tokenBase64}`
            },
            body: JSON.stringify({
                amount: total,
                currency: 'MXN',
                purchase_description: 'Compra en Krüger',
                redirection_url: {
                    success: "https://krugermx-web.github.io/KrugerDistribuidora/success.html",
                    error: "https://krugermx-web.github.io/KrugerDistribuidora/index.html",
                    default: "https://krugermx-web.github.io/KrugerDistribuidora/success.html"
                },
                payer_email: ordenKruger?.customerEmail || "cliente@kruger.com",
                metadata: {
                    orden_json: JSON.stringify(ordenKruger || {})
                }
            })
        });

        const data = await response.json();

        if (data.payment_request_url) {
            res.json({ checkoutUrl: data.payment_request_url });
        } else {
            res.status(400).json({ error: "No se pudo generar el pago con Clip" });
        }

    } catch (error) {
        res.status(500).json({ error: "Error interno" });
    }
});

// =================================================================
// RUTA 2: EL WEBHOOK (Notificaciones de Clip, Firebase y Correo)
// =================================================================
app.post('/webhook-clip', async (req, res) => {
    const notificacion = req.body;
    console.log("¡Aviso de Clip recibido!");

    // Siempre debemos responderle a Clip con un 200 OK inmediatamente
    res.status(200).send('OK');

    // Procesamos el pago solo si fue APROBADO en segundo plano
    if (notificacion.status === 'APPROVED') {
        try {
            const totalPagado = notificacion.amount;
            const correoCliente = notificacion.payer_email || "cliente@kruger.com";
            
            // Recuperamos los datos de la orden
            let orden = {};
            if (notificacion.metadata && notificacion.metadata.orden_json) {
                orden = JSON.parse(notificacion.metadata.orden_json);
            }

            // =========================================================
            // 1. GUARDAR LA ORDEN EN FIREBASE DESDE EL SERVIDOR
            // =========================================================
            try {
                orden.status = "Pagado y Confirmado (Clip)";
                orden.fechaPago = new Date().toISOString();
                orden.transaccionId = notificacion.receipt_no || "Sin folio";
                
                await addDoc(collection(db, "orders"), orden);
                console.log("✅ ORDEN GUARDADA EXITOSAMENTE EN FIREBASE DESDE EL SERVIDOR");
            } catch (fbError) {
                console.error("❌ Error al guardar en Firebase:", fbError);
            }

            // =========================================================
            // 2. ENVIAR CORREO DE CONFIRMACIÓN
            // =========================================================
            let productosHTML = "";
            if (orden.items && orden.items.length > 0) {
                orden.items.forEach(item => {
                    let extraInstalacion = item.wantsInstall ? `<br><small style="color: #D31145;">+ Incluye Instalación Certificada ($${item.installPrice})</small>` : '';
                    productosHTML += `
                        <div style="padding: 12px 0; border-bottom: 1px solid #eee;">
                            <strong style="color: #333;">${item.quantity}x ${item.name}</strong> 
                            <span style="float: right; color: #333; font-weight: bold;">$${item.price * item.quantity} MXN</span>
                            ${extraInstalacion}
                        </div>
                    `;
                });
            } else {
                productosHTML = `<p style="color: #666;">Calentador Krüger - Pago Seguro con Clip</p>`;
            }

            const detallesEnvio = `
                <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #eee; margin-top: 25px;">
                    <h4 style="margin-top: 0; color: #002855; border-bottom: 1px solid #ddd; padding-bottom: 8px;">Detalles de Entrega</h4>
                    <p style="margin: 5px 0; font-size: 14px;"><strong>Cliente:</strong> ${orden.customerName || 'No especificado'}</p>
                    <p style="margin: 5px 0; font-size: 14px;"><strong>Teléfono:</strong> ${orden.customerPhone || 'No especificado'}</p>
                    <p style="margin: 5px 0; font-size: 14px;"><strong>Dirección de Envío:</strong> ${orden.shippingAddress || 'No especificada'}</p>
                    ${orden.needsInstall ? `
                        <h4 style="margin-top: 15px; color: #002855; border-bottom: 1px solid #ddd; padding-bottom: 8px;">Cita de Instalación</h4>
                        <p style="margin: 5px 0; font-size: 14px;"><strong>Dirección a instalar:</strong> ${orden.installAddress || orden.shippingAddress}</p>
                        <p style="margin: 5px 0; font-size: 14px;"><strong>Horario solicitado:</strong> ${orden.installSchedule || 'A coordinar'}</p>
                    ` : ''}
                </div>
            `;

            const mailOptions = {
                from: '"Tienda Krüger" <krugerdistribudorautorizado@gmail.com>',
                to: correoCliente,
                subject: 'Detalles de tu orden Krüger - ¡Pago Aprobado!',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 600px; margin: auto; border: 1px solid #e5e7eb; border-top: 6px solid #ff5a00; border-radius: 12px; background-color: #ffffff;">
                        <div style="text-align: center; margin-bottom: 25px;">
                            <h2 style="color: #002855; margin-bottom: 5px;">¡Gracias por tu compra, ${orden.customerName ? orden.customerName.split(' ')[0] : ''}!</h2>
                            <p style="color: #22c55e; font-weight: bold; font-size: 16px; margin-top: 0; padding: 8px; background-color: #dcfce7; border-radius: 6px; display: inline-block;">Tu pago por $${totalPagado} MXN fue aprobado.</p>
                        </div>
                        <h3 style="color: #002855; margin-bottom: 10px;">Resumen de tu pedido</h3>
                        ${productosHTML}
                        ${detallesEnvio}
                        <p style="margin-top: 25px; font-size: 15px; color: #4b5563; line-height: 1.5;">Tu orden ya está confirmada. Nos pondremos en contacto contigo a la brevedad para coordinar la entrega en tu domicilio.</p>
                        <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0 20px;">
                        <p style="font-size: 11px; color: #9ca3af; text-align: center; text-transform: uppercase; letter-spacing: 1px;">Krüger - Distribuidor Autorizado<br>Este es un comprobante automático, por favor no respondas a este correo.</p>
                    </div>
                `
            };

            transporter.sendMail(mailOptions, (error, info) => {
                if (error) console.error("❌ Error enviando correo:", error);
                else console.log("✅ Correo enviado con éxito al cliente:", correoCliente);
            });

        } catch (err) {
             console.error("Error procesando la notificación de Clip:", err);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Servidor Clip-Krüger activo en el puerto " + PORT);
});
