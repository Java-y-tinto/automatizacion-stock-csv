import { graphql } from "../functions";
import { subirArchivoPublicacionShopify, vigilarOperacion, verErroresBulk } from "./staged_upload";

async function obtenerTodosLosCanales() {
    const query = `
        query {
            publications(first: 20) {
                edges {
                    node {
                        id
                        name
                    }
                }
            }
        }
    `;
    const respuesta = await graphql(query);

    const canales = respuesta.publications?.edges.map((e: any) => e.node.id);

    if (!canales || canales.length === 0) throw new Error("No se encontraron canales de venta");
    return canales;
}

export async function generarArchivoPublicacion(urlResultadosPrimerBulk: string) {
    console.log("Descargando IDs de los productos recién procesados...");
    const response = await fetch(urlResultadosPrimerBulk);
    const text = await response.text();

    const idsCanales = await obtenerTodosLosCanales();
    const lineas = text.split('\n').filter(line => line.trim() !== '');

    const jsonlLineas = [];
    const inputCanales = idsCanales.map((id: string) => ({ publicationId: id }));

    for (const linea of lineas) {
        const data = JSON.parse(linea);
        const idProducto = data.data?.productSet?.product?.id;

        if (idProducto) {
            const payload = {
                id: idProducto,
                input: inputCanales
            };
            jsonlLineas.push(JSON.stringify(payload));
        }
    }

    const nombreArchivo = "publicar_productos.jsonl";
    await Bun.write(nombreArchivo, jsonlLineas.join('\n'));
    console.log(`Archivo de publicación generado para ${jsonlLineas.length} productos en ${idsCanales.length} canales distintos.`);

    return nombreArchivo;
}

export async function publicarProductosBulk(bulkId: string): Promise<string | null> {
    console.log("\nIniciando publicación en canales de venta...");

    const queryUrl = `query { node(id: "${bulkId}") { ... on BulkOperation { url } } }`;
    const resUrl = await graphql(queryUrl);
    const urlResultados = resUrl.node?.url;

    if (!urlResultados) {
        console.log("No se pudo obtener la URL de resultados para publicar. Saltando paso.");
        return null;
    }

    const archivoBulkPublicar = await generarArchivoPublicacion(urlResultados);
    const bulkIdPublicar = await subirArchivoPublicacionShopify(archivoBulkPublicar);

    await vigilarOperacion(bulkIdPublicar);
    await verErroresBulk(bulkIdPublicar);

    return archivoBulkPublicar;
}