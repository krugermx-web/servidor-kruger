const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");
const { initializeApp } = require("firebase/app");
const { getFirestore, collection, doc, updateDoc, getDoc, getDocs, query, where } = require("firebase/firestore");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

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
const auth = getAuth(appFirebase);

// Variables de entorno para Firebase (Tu acceso al Admin)
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;

// =================================================================
// AUTENTICACIÓN EN FIREBASE
// =================================================================
signInWithEmailAndPassword(auth, adminEmail, adminPassword)
    .then(() => console.log("✅ Servidor autenticado exitosamente en Firebase como Admin."))
    .catch((error) => console.error("❌ Error al iniciar sesión en el servidor:", error.message));

// =================================================================
// CONFIGURACIÓN DE NODEMAILER CON TU GMAIL REAL
// =================================================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'krugerdistribudorautorizado@gmail.com', // Tu correo real de la tienda
        pass: process.env.EMAIL_PASS // Tu contraseña de aplicación segura en Render
    }
});

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// =================================================================
// RUTA 1: CREAR PAGO CLIP
// =================================================================
app.post("/crear-pago-clip", async (req, res) => {
    try {
        const { total, ordenKruger } = req.body;
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
                payer_email: ordenKruger?.customerEmail || "krugerdistribudorautorizado@gmail.com",
                metadata: { orderId: ordenKruger?.orderId || "" }
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
// RUTA 2: WEBHOOK DE CLIP (Actualiza Firebase y Envía Correo)
// =================================================================
app.post('/webhook-clip', async (req, res) => {
    const notificacion = req.body;
    console.log("¡Aviso de Clip recibido!");
    res.status(200).send('OK');

    try {
        const status = (notificacion.status || "").toUpperCase();
        const eventType = (notificacion.event_type || "").toUpperCase();
        const paymentObj = notificacion.payment || notificacion.payment_detail || {};
        const pStatus = (paymentObj.status || "").toUpperCase();
        
        const amount = notificacion.amount || paymentObj.amount || 0;
        const receipt = notificacion.receipt_no || paymentObj.receipt_no || "Sin folio";
        
        let meta = notificacion.metadata || paymentObj.metadata || (notificacion.payment_request_detail && notificacion.payment_request_detail.metadata) || {};
        let orderId = meta.orderId || "";

        const esRechazado = status.includes('DECLIN') || status.includes('REJECT') || status.includes('FAIL') || status.includes('CANC') || pStatus.includes('DECLIN');
        if (esRechazado) return;

        const esAprobado = status.includes('APPROV') || status.includes('PAID') || eventType.includes('COMPLETED') || pStatus.includes('COMPLET') || pStatus.includes('PAID');

        if (esAprobado) {
            
            // BÚSQUEDA: Si Clip esconde el ID, tomamos la última orden pendiente de pago
            if (!orderId) {
                console.log("Buscando la última orden pendiente de pago en Firebase...");
                const q = query(collection(db, "orders"), where("status", "==", "Pendiente de Pago"));
                const querySnapshot = await getDocs(q);
                
                if (!querySnapshot.empty) {
                    let docsList = [];
                    querySnapshot.forEach(d => {
                        let obj = d.data();
                        if (obj.createdAt && obj.createdAt.seconds) {
                            docsList.push({ id: d.id, ...obj });
                        }
                    });
                    
                    if (docsList.length > 0) {
                        docsList.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);
                        orderId = docsList[0].id; 
                        console.log("✅ ¡Última orden rescatada de emergencia! ID:", orderId);
                    }
                }
            }

            if (orderId) {
                const orderRef = doc(db, "orders", orderId);
                const orderSnap = await getDoc(orderRef);

                if (orderSnap.exists()) {
                    const ordenData = orderSnap.data();
                    
                    try {
                        await updateDoc(orderRef, {
                            status: "Pagado",
                            transaccionId: receipt
                        });
                        console.log("✅ ORDEN MARCADA COMO PAGADA EXÍTOSAMENTE EN LA BASE DE DATOS");
                    } catch (e) {
                        console.error("❌ Error escribiendo en Firebase:", e);
                    }

                    // ==========================================
                    // PLANTILLA DE CORREO (FORMATO PREMIUM)
                    // ==========================================
                    let productosHTML = "";
                    if (ordenData.items && ordenData.items.length > 0) {
                        ordenData.items.forEach(item => {
                            let detalles = [];
                            if (item.gasType) detalles.push(`Gas: ${item.gasType}`);
                            if (item.size) detalles.push(`Medida: ${item.size}`);
                            let extraText = detalles.length > 0 ? `<div style="color: #666; font-size: 12px; margin-top: 4px;">${detalles.join(' | ')}</div>` : '';
                            let instText = item.wantsInstall ? `<div style="color: #D31145; font-size: 12px; font-weight: bold; margin-top: 4px;">+ Instalación Certificada ($${item.installPrice.toLocaleString('es-MX')})</div>` : '';
                            
                            productosHTML += `
                                <div style="padding: 15px 0; border-bottom: 1px solid #f0f0f0;">
                                    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0;">
                                        <tr>
                                            <td width="80%" style="vertical-align: top;">
                                                <strong style="color: #002855; font-size: 16px;">${item.quantity}x ${item.name}</strong>
                                                ${extraText}
                                                ${instText}
                                            </td>
                                            <td width="20%" style="vertical-align: top; text-align: right;">
                                                <strong style="color: #333; font-size: 16px;">$${((item.price + (item.wantsInstall ? item.installPrice : 0)) * item.quantity).toLocaleString('es-MX')}</strong>
                                            </td>
                                        </tr>
                                    </table>
                                </div>
                            `;
                        });
                    }

                    let instalacionHTML = ordenData.needsInstall ? `
                        <div style="background-color: #f4f6f8; border-left: 4px solid #D31145; padding: 15px; margin-top: 20px; border-radius: 4px;">
                            <h4 style="margin: 0 0 10px 0; color: #002855; font-size: 14px; text-transform: uppercase;">Cita de Instalación</h4>
                            <p style="margin: 3px 0; font-size: 14px; color: #444;"><strong>Dirección:</strong> ${ordenData.installAddress || ordenData.shippingAddress}</p>
                            <p style="margin: 3px 0; font-size: 14px; color: #444;"><strong>Horario solicitado:</strong> ${ordenData.installSchedule || 'Pendiente de coordinar'}</p>
                        </div>
                    ` : '';

                    const emailTemplate = `
                    <!DOCTYPE html>
                    <html>
                    <body style="margin: 0; padding: 0; background-color: #f8f9fa; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
                        <div style="max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                            <!-- Header -->
                            <div style="background-color: #002855; padding: 30px 20px; text-align: center;">
                                <img src="https://krugermx-web.github.io/KrugerDistribuidora/logo-kruger-blanco.png" alt="Krüger" style="height: 40px; margin-bottom: 15px;" onerror="this.style.display='none'">
                                <h1 style="color: #ffffff; margin: 0; font-size: 22px; letter-spacing: 1px;">¡PAGO APROBADO!</h1>
                                <p style="color: #a0aec0; margin: 10px 0 0 0; font-size: 14px;">Folio de transacción: ${receipt}</p>
                            </div>
                            
                            <!-- Body -->
                            <div style="padding: 30px 40px;">
                                <h2 style="color: #333; font-size: 20px; margin-top: 0;">Hola, ${ordenData.customerName || 'Cliente'}</h2>
                                <p style="color: #666; font-size: 16px; line-height: 1.5;">Hemos recibido tu pago con éxito. Tu pedido ya está en nuestro sistema y comenzaremos a procesarlo de inmediato.</p>
                                
                                <h3 style="color: #002855; border-bottom: 2px solid #002855; padding-bottom: 8px; margin-top: 30px; font-size: 16px; text-transform: uppercase;">Resumen de tu Compra</h3>
                                ${productosHTML}
                                
                                <div style="text-align: right; margin-top: 20px;">
                                    <span style="font-size: 14px; color: #666;">Total pagado:</span><br>
                                    <strong style="color: #D31145; font-size: 28px;">$${Number(amount).toLocaleString('es-MX')} <span style="font-size: 16px; color: #888;">MXN</span></strong>
                                </div>

                                <h3 style="color: #002855; border-bottom: 2px solid #002855; padding-bottom: 8px; margin-top: 30px; font-size: 16px; text-transform: uppercase;">Detalles de Entrega</h3>
                                <p style="margin: 5px 0; font-size: 14px; color: #444;"><strong>Dirección de envío:</strong><br>${ordenData.shippingAddress || 'No especificada'}</p>
                                <p style="margin: 10px 0 5px 0; font-size: 14px; color: #444;"><strong>Teléfono de contacto:</strong><br>${ordenData.customerPhone || 'No especificado'}</p>
                                
                                ${instalacionHTML}
                                
                                <p style="color: #666; font-size: 14px; line-height: 1.5; margin-top: 30px; background-color: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center;">
                                    Nos pondremos en contacto contigo a la brevedad para coordinar la entrega.<br>
                                    ¿Tienes dudas? Escríbenos a <strong>krugerdistribudorautorizado@gmail.com</strong>
                                </p>
                            </div>
                            
                            <!-- Footer -->
                            <div style="background-color: #e2e8f0; padding: 20px; text-align: center;">
                                <p style="color: #64748b; font-size: 12px; margin: 0;">© 2026 Krüger Distribuidor Autorizado.<br>Todos los derechos reservados. León, Guanajuato, México.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                    `;

                    // ==========================================
                    // ENVÍO DE CORREO USANDO NODEMAILER
                    // ==========================================
                    if (ordenData.customerEmail) {
                        try {
                            const info = await transporter.sendMail({
                                from: '"Tienda Krüger" <krugerdistribudorautorizado@gmail.com>', // Sale desde tu Gmail
                                to: ordenData.customerEmail, // Llega al correo de tu cliente real
                                subject: '💳 ¡Tu recibo de Krüger está listo! - Pago Aprobado',
                                html: emailTemplate
                            });
                            console.log("✅ Correo enviado con éxito mediante Nodemailer. ID:", info.messageId);
                        } catch (emailError) { 
                            console.error("❌ Error enviando correo vía Nodemailer:", emailError); 
                        }
                    }
                }
            } else {
                console.log("⚠️ Pago aprobado pero no hay ninguna orden pendiente en Firebase para asignarle.");
            }
        }
    } catch (err) {
         console.error("❌ Error procesando el webhook:", err);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Clip-Krüger activo en el puerto " + PORT));
