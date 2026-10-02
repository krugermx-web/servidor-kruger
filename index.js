const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// PEGA AQUÍ TU ACCESS TOKEN DE PRODUCCIÓN (APP_USR-...)
const client = new MercadoPagoConfig({ accessToken: 'APP_USR-2842018947277573-100121-90bbe447e7a39369b6c2dee6ee4a3f97-3732663698' });

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
            // CORRECCIÓN: URLs 100% seguras (https) exigidas por Mercado Pago en Producción
            back_urls: {
                success: "https://tienda-kruger.web.app",
                failure: "https://tienda-kruger.web.app",
                pending: "https://tienda-kruger.web.app"
            },
            auto_return: "approved",
        };
        const result = await preference.create({ body });
        res.json({ id: result.id });
    } catch (error) {
        console.error("Error Mercado Pago:", error);
        res.status(500).json({ error: "Error al generar cobro" });
    }
});

// Render asigna el puerto automáticamente
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Servidor seguro activo en el puerto " + PORT);
});