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
app.post("/process_payment", async (req, res) => {
    try {
        const payment = new Payment(client);
        // Mercado Pago nos manda los datos encriptados de la tarjeta y aquí los procesamos
        const result = await payment.create({ body: req.body });
        res.json({ status: result.status, status_detail: result.status_detail, id: result.id });
    } catch (error) {
        console.error("Error al procesar pago:", error);
        res.status(500).json({ error: "No se pudo procesar el pago" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Servidor seguro activo en el puerto " + PORT);
});
