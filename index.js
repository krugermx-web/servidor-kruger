const express = require("express");
const cors = require("cors");
// IMPORTANTE: Ahora importamos "Payment" además de Preference
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const nodemailer = require("nodemailer");

// Configurar el "cartero" de Gmail de forma segura
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'krugerdistribudorautorizado@gmail.com', // <-- Le agregué @gmail.com para evitar errores de conexión
        pass: process.env.EMAIL_PASS // <--- ¡La contraseña real ya no está en el código!
    }
});

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Tu token seguro en Render
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADO_PAGO_TOKEN });

// RUTA 1: Crear la orden (Preferencias)
app.post("/create_preference", async (req, res) => {
    try {
        const preference = new Preference(client);
        const body = {
            items: req.body.items.map(item => ({
                title: item.name + (item.wantsInstall ? " (+ Instalación)" : ""),
                quantity: Number(item.quantity),
                unit_price: Number(item.price + (item.wantsInstall ? item.installPrice : 0)),
                currency_id: "MXN",
            })),
            // Eliminamos las back_urls y el auto_return para evitar que tu página se esté recargando como loca
        };
        const result = await preference.create({ body });
        res.json({ id: result.id });
    } catch (error) {
        console.error("Error al crear preferencia:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

// RUTA 2: Procesar el cobro de la tarjeta directamente
app.post("/process_payment", async (req, res) => {
    try {
        const payment = new Payment(client);
        
        // Recibimos los datos del Brick y aseguramos la estructura que exige Mercado Pago
        const body = {
            transaction_amount: Number(req.body.transaction_amount),
            token: req.body.token,
            description: req.body.description || "Compra en Tienda Krüger",
            installments: Number(req.body.installments || 1),
            payment_method_id: req.body.payment_method_id,
            issuer_id: req.body.issuer_id ? Number(req.body.issuer_id) : undefined,
            payer: {
                email: req.body.payer?.email || "cliente@kruger.com",
                identification: {
                    // Forzamos un tipo y número genérico válido para evitar el rechazo
                    type: "RFC",
                    number: "XAXX010101000" // RFC genérico estándar en México para público en general
                }
            }
        };

        const result = await payment.create({ body });

        // =========================================================================
        // NUEVO: SI EL PAGO ES APROBADO, ENVIAMOS EL CORREO CON EL DESGLOSE COMPLETO
        // =========================================================================
        if (result.status === "approved") {
            const correoCliente = req.body.payer?.email || "cliente@kruger.com";
            const totalPagado = req.body.transaction_amount;
            const orden = req.body.ordenKruger || {}; // Recibimos todo el carrito desde el front-end

            // 1. Armamos la lista de productos
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
                productosHTML = `<p style="color: #666;">Calentador Krüger - Pago Seguro</p>`;
            }

            // 2. Armamos la caja con detalles de envío
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

            // 3. Plantilla final del Correo
            const mailOptions = {
                from: '"Tienda Krüger" <krugerdistribudorautorizado@gmail.com>',
                to: correoCliente,
                subject: 'Detalles de tu orden Krüger - ¡Pago Aprobado!',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 600px; margin: auto; border: 1px solid #e5e7eb; border-top: 6px solid #002855; border-radius: 12px; background-color: #ffffff;">
                        
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

            // 4. Disparamos el correo en segundo plano
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) console.error("Error enviando correo:", error);
                else console.log("Correo enviado con éxito al cliente:", correoCliente);
            });
        }
        // =========================================================================

        // Respondemos a tu página de GitHub Pages
        res.json({ 
            status: result.status, 
            status_detail: result.status_detail, 
            id: result.id 
        });
    } catch (error) {
        console.error("Error detallado al procesar pago:", error);
        res.status(400).json({ 
            error: error.message || "Error al procesar el pago con el banco" 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Servidor seguro activo en el puerto " + PORT);
});
