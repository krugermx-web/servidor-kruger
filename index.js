const express = require("express");
const cors = require("cors");
// IMPORTANTE: Ahora importamos "Payment" además de Preference
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

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

// RUTA 2 (NUEVA): Procesar el cobro de la tarjeta directamente
// RUTA PARA PROCESAR EL PAGO DIRECTO
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
        res.json({ 
            status: result.status, 
            status_detail: result.status_detail, 
            id: result.id 
        });
    } catch (error) {
        console.error("Error detallado al procesar pago:", error);
        // Devolvemos el mensaje exacto del banco para que sepas qué falló
        res.status(400).json({ 
            error: error.message || "Error al procesar el pago con el banco" 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Servidor seguro activo en el puerto " + PORT);
});
