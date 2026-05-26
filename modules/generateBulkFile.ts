import { graphql } from "../functions";

// ─── Types ───────────────────────────────────────────────────────────────────

type ShopifyId = {
    productId: string;
    variantId: string;
    hasImages: boolean;
};

type ProductMaps = {
    mapaPorSku: Map<string, ShopifyId>;
    mapaPorHandle: Map<string, ShopifyId>;
};

export type CSVRow = {
    id: string;
    title: string;
    price: string;
    sale_price: string;
    stock: string;
    image_link?: string;
    DESCRIPTION?: string;
    [key: string]: unknown;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toHandle(title: string, sku: string): string {
    return `${title}-${sku}`
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
}

function toStock(raw: string | number): number {
    // Parse only the leading integer — avoids "0.5" (size column bleed) becoming 5
    const parsed = parseInt(String(raw), 10);
    return isNaN(parsed) ? 0 : Math.max(0, parsed);
}

function toPrice(salePrice: string, fallback: string): string {
    const n = parseFloat(salePrice);
    return isNaN(n) || n <= 0 ? fallback : salePrice;
}

function deduplicateBySku(rows: CSVRow[]): CSVRow[] {
    return [...new Map(rows.map((row) => [row.id, row])).values()];
}

// ─── Shopify Bulk Read ────────────────────────────────────────────────────────

async function obtenerMapaProductos(): Promise<ProductMaps> {
    console.log("Solicitando volcado de productos existentes a Shopify...");

    const initRes = await graphql(`
        mutation {
            bulkOperationRunQuery(
                query: """
                {
                    products {
                        edges {
                            node {
                                id
                                handle
                                featuredMedia { id }
                                variants {
                                    edges {
                                        node {
                                            id
                                            sku
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                """
            ) {
                bulkOperation { id status }
                userErrors { message }
            }
        }
    `);

    const bulkId = initRes.bulkOperationRunQuery?.bulkOperation?.id;
    if (!bulkId) throw new Error("No se pudo iniciar la consulta Bulk en Shopify.");

    // Polling with exponential backoff
    console.log(`Esperando a que Shopify genere el diccionario (ID: ${bulkId})...`);
    let urlDescarga: string | null = null;
    let delay = 5_000;

    while (true) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000); // cap at 30s

        const pollRes = await graphql(`
            query {
                node(id: "${bulkId}") {
                    ... on BulkOperation { status url }
                }
            }
        `);

        const { status, url } = pollRes.node;
        if (status === "COMPLETED") { urlDescarga = url; break; }
        if (status === "FAILED" || status === "CANCELED") {
            throw new Error(`La operación de lectura bulk falló: ${status}`);
        }
    }

    const mapaPorSku = new Map<string, ShopifyId>();
    const mapaPorHandle = new Map<string, ShopifyId>();

    if (!urlDescarga) {
        console.log("No hay productos previos. Se crearán todos desde cero.");
        return { mapaPorSku, mapaPorHandle };
    }

    // Parse JSONL — each line is either a product or a variant (__parentId)
    const text = await fetch(urlDescarga).then((r) => r.text());
    const productosTemp = new Map<string, { handle: string; variantId: string | null; sku: string | null; hasImages: boolean }>();

    for (const linea of text.split("\n").filter(Boolean)) {
        try {
            const data = JSON.parse(linea);
            if (data.handle) {
                productosTemp.set(data.id, { handle: data.handle, variantId: null, sku: null, hasImages: !!data.featuredMedia });
            } else if (data.__parentId) {
                const prod = productosTemp.get(data.__parentId);
                if (prod) { prod.variantId = data.id; prod.sku = data.sku; }
            }
        } catch {
            console.warn(`[WARN] Línea JSONL malformada, se omite: ${linea.slice(0, 80)}`);
        }
    }

    for (const [productId, info] of productosTemp.entries()) {
        if (!info.variantId) continue;
        const entry: ShopifyId = { productId, variantId: info.variantId, hasImages: info.hasImages };
        if (info.sku) mapaPorSku.set(info.sku, entry);
        if (info.handle) mapaPorHandle.set(info.handle, entry);
    }

    console.log(`Diccionarios listos: ${productosTemp.size} productos cargados.`);
    return { mapaPorSku, mapaPorHandle };
}

// ─── Bulk File Generator ──────────────────────────────────────────────────────

async function generateBulkFile(
    data: CSVRow[],
    rutaSalida: string,
    // Injected for testing — defaults to real Shopify fetch
    getMaps: () => Promise<ProductMaps> = obtenerMapaProductos
) {
    if (!process.env.SHOPIFY_LOCATION_ID) {
        throw new Error("SHOPIFY_LOCATION_ID no está definido en el entorno.");
    }

    const { mapaPorSku, mapaPorHandle } = await getMaps();

    const filas = deduplicateBySku(data).filter((row) => row.title?.trim());

    const MAX_IMAGE_UPLOADS = 500;
    let imageUploadsThisRun = 0;

    const lines = filas.map((item) => {
        const titulo = item.title.trim();
        const handle = toHandle(titulo, item.id);
        const stock = toStock(item.stock);
        const price = toPrice(item.sale_price, item.price);

        // Double lookup: SKU first, then handle (rescues renamed products)
        const existente = mapaPorSku.get(item.id) ?? mapaPorHandle.get(handle);
        if (existente && !mapaPorSku.has(item.id)) {
            console.log(`[OK] Producto "${item.id}" rescatado por handle.`);
        }

        const needsImage = item.image_link?.trim() && (!existente || !existente.hasImages) && imageUploadsThisRun < MAX_IMAGE_UPLOADS;
        if (needsImage) imageUploadsThisRun++;
        const filesField = needsImage ? {
            files: [{
                originalSource: item.image_link!.trim(),
                contentType: "IMAGE",
                alt: titulo,
            }]
        } : {};

        const payload = {
            input: {
                ...(existente ? { id: existente.productId } : { handle }),
                title: titulo,
                descriptionHtml: item.DESCRIPTION?.trim() || titulo,
                status: "ACTIVE",
                productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
                ...filesField,
                collections: ["gid://shopify/Collection/699670921603"],
                variants: [{
                    ...(existente ? { id: existente.variantId } : {}),
                    sku: item.id,
                    price,
                    optionValues: [{ optionName: "Title", name: "Default Title" }],
                    inventoryItem: { tracked: true },
                    inventoryQuantities: [{
                        locationId: `gid://shopify/Location/${process.env.SHOPIFY_LOCATION_ID}`,
                        name: "available",
                        quantity: stock,
                    }],
                }],
            },
        };

        return JSON.stringify(payload);
    });

    await Bun.write(rutaSalida, lines.join("\n"));
    console.log(`Archivo bulk generado: ${lines.length} productos válidos → ${rutaSalida}`);
}

export default generateBulkFile;