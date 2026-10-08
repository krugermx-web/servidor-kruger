const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { Resend } = require("resend");
const { initializeApp } = require("firebase/app");
// Se importa getDocs, query y where para buscar órdenes
const { getFirestore, collection, doc, updateDoc, getDoc, getDocs, query, where } = require("firebase/firestore");

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

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// =================================================================
// RUTA 1: CREAR EL LINK DE PAGO CLIP
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
                metadata: {
                    orderId: ordenKruger?.orderId || ""
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
// RUTA 2: EL WEBHOOK (Actualiza Firebase y Envía Correo)
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
        
        // 1. Buscamos el ID en los metadatos (por si Clip decide enviarlo alguna vez)
        let meta = notificacion.metadata || paymentObj.metadata || (notificacion.payment_request_detail && notificacion.payment_request_detail.metadata) || {};
        let orderId = meta.orderId || "";

        console.log(`🔎 Status: ${status} | Event: ${eventType} | OrderID Original: ${orderId}`);

        const esRechazado = status.includes('DECLIN') || status.includes('REJECT') || status.includes('FAIL') || status.includes('CANC') ||
                            pStatus.includes('DECLIN') || pStatus.includes('REJECT') || pStatus.includes('FAIL');

        if (esRechazado) {
            console.log("⚠️ El pago fue rechazado.");
            return;
        }

        // Criterios de pago exitoso de Clip
        const esAprobado = status.includes('APPROV') || status.includes('PAID') || eventType.includes('COMPLETED') || pStatus.includes('COMPLET') || pStatus.includes('PAID');

        if (esAprobado) {
            
            // ¡NUEVA MAGIA INFALIBLE!: Si Clip esconde el ID, tomamos la orden más reciente "Pendiente de Pago"
            if (!orderId) {
                console.log("Buscando la última orden pendiente de pago en Firebase...");
                const q = query(
                    collection(db, "orders"), 
                    where("status", "==", "Pendiente de Pago")
                );
                
                const querySnapshot = await getDocs(q);
                if (!querySnapshot.empty) {
                    let docsList = [];
                    querySnapshot.forEach(d => docsList.push({ id: d.id, ...d.data() }));
                    
                    // Ordenamos para tomar siempre la más reciente (la que acaba de hacer este cliente)
                    docsList.sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);
                    
                    orderId = docsList[0].id; 
                    console.log("✅ ¡Orden pendiente rescatada con éxito! ID:", orderId);
                }
            }

            // AHORA SÍ, ACTUALIZAMOS LA ORDEN A "PAGADO" Y ENVIAMOS EL CORREO
            if (orderId) {
                const orderRef = doc(db, "orders", orderId);
                const orderSnap = await getDoc(orderRef);

                if (orderSnap.exists()) {
                    const ordenData = orderSnap.data();
                    
                    // Actualizamos Firebase
                    await updateDoc(orderRef, {
                        status: "Pagado",
                        transaccionId: receipt
                    });
                    console.log("✅ ORDEN ACTUALIZADA A PAGADO EN EL ADMIN");

                    // Construimos los productos para el correo
                    let productosHTML = "";
                    if (ordenData.items && ordenData.items.length > 0) {
                        ordenData.items.forEach(item => {
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
                            <p style="margin: 5px 0; font-size: 14px;"><strong>Cliente:</strong> ${ordenData.customerName || 'No especificado'}</p>
                            <p style="margin: 5px 0; font-size: 14px;"><strong>Teléfono:</strong> ${ordenData.customerPhone || 'No especificado'}</p>
                            <p style="margin: 5px 0; font-size: 14px;"><strong>Dirección de Envío:</strong> ${ordenData.shippingAddress || 'No especificada'}</p>
                            ${ordenData.needsInstall ? `
                                <h4 style="margin-top: 15px; color: #002855; border-bottom: 1px solid #ddd; padding-bottom: 8px;">Cita de Instalación</h4>
                                <p style="margin: 5px 0; font-size: 14px;"><strong>Dirección a instalar:</strong> \${ordenData.installAddress || ordenData.shippingAddress}</p>
                                <p style="margin: 5px 0; font-size: 14px;"><strong>Horario solicitado:</strong> \${ordenData.installSchedule || 'A coordinar'}</p>
                            ` : ''}
                        </div>
                    `;

                    if (ordenData.customerEmail) {
                        try {
                            await resend.emails.send({
                                from: 'Tienda Krüger <onboarding@resend.dev>',
                                to: [ordenData.customerEmail],
                                subject: 'Detalles de tu orden Krüger - ¡Pago Aprobado!',
                                html: `
                                    <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 600px; margin: auto; border: 1px solid #e5e7eb; border-top: 6px solid #ff5a00; border-radius: 12px; background-color: #ffffff;">
                                        <div style="text-align: center; margin-bottom: 25px;">
                                            <h2 style="color: #002855; margin-bottom: 5px;">¡Gracias por tu compra, ${ordenData.customerName ? ordenData.customerName.split(' ')[0] : 'Cliente'}!</h2>
                                            <p style="color: #22c55e; font-weight: bold; font-size: 16px; margin-top: 0; padding: 8px; background-color: #dcfce7; border-radius: 6px; display: inline-block;">Tu pago por $${amount} MXN fue aprobado.</p>
                                        </div>
                                        <h3 style="color: #002855; margin-bottom: 10px;">Resumen de tu pedido</h3>
                                        ${productosHTML}
                                        ${detallesEnvio}
                                        <p style="margin-top: 25px; font-size: 15px; color: #4b5563; line-height: 1.5;">Tu orden ya está confirmada. Nos pondremos en contacto contigo a la brevedad para coordinar la entrega en tu domicilio.</p>
                                    </div>
                                `
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
