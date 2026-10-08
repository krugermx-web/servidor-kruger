const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { Resend } = require("resend");
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

// =================================================================
// AUTENTICACIÓN INVISIBLE DEL SERVIDOR (Segura con Variables de Entorno)
// =================================================================
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;

signInWithEmailAndPassword(auth, adminEmail, adminPassword)
    .then(() => {
        console.log("✅ Servidor autenticado exitosamente en Firebase como Admin.");
    })
    .catch((error) => {
        console.error("❌ Error al iniciar sesión en el servidor:", error.message);
    });

const resend = new Resend(process.env.RESEND_API_KEY);

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
// RUTA 2: WEBHOOK (Actualiza Firebase a prueba de fallos)
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
            
            // BÚSQUEDA A PRUEBA DE BALAS: Si Clip esconde el ID, tomamos la última orden pendiente
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
                        orderId = docsList[0].id; // La más reciente
                        console.log("✅ ¡Última orden rescatada de emergencia! ID:", orderId);
                    }
                }
            }

            // ACTUALIZACIÓN DIRECTA EN FIREBASE Y ENVÍO DE CORREO
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

                    // ARMADO Y ENVÍO DE CORREO OFICIAL DE LA TIENDA
                    let productosHTML = "";
                    if (ordenData.items && ordenData.items.length > 0) {
                        ordenData.items.forEach(item => {
                            let extraInstalacion = item.wantsInstall ? `<br><small style="color: #D31145;">+ Instalación ($${item.installPrice})</small>` : '';
                            productosHTML += `<div style="padding: 10px 0; border-bottom: 1px solid #eee;"><strong>${item.quantity}x ${item.name}</strong> <span style="float:right">$${item.price * item.quantity}</span>${extraInstalacion}</div>`;
                        });
                    }

                    if (ordenData.customerEmail) {
                        try {
                            await resend.emails.send({
                                from: 'Tienda Krüger <onboarding@resend.dev>',
                                to: [ordenData.customerEmail], // Recuerda usar el correo de tu cuenta Resend si estás en el plan gratuito
                                subject: '¡Tu pedido Krüger está Pagado!',
                                html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
                                        <h2>¡Gracias por tu compra, ${ordenData.customerName || 'Cliente'}!</h2>
                                        <p>Tu pago por $${amount} MXN fue aprobado.</p>
                                        <div style="background: #f9f9f9; padding: 15px; margin: 15px 0;">
                                            ${productosHTML}
                                        </div>
                                        <p><strong>Dirección de entrega:</strong> ${ordenData.shippingAddress || 'No especificada'}</p>
                                      </div>`
                            });
                            console.log("✅ Correo enviado con éxito al cliente:", ordenData.customerEmail);
                        } catch (emailError) {
                            console.error("❌ Error enviando correo vía Resend:", emailError);
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
app.listen(PORT, () => {
    console.log("Servidor Clip-Krüger activo en el puerto " + PORT);
});
