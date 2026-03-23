import downloadCSV from "./modules/download";
import processCSV from "./modules/parse";
import generateBulkFile from "./modules/generateBulkFile";
import { subirArchivoShopify, vigilarOperacion, verErroresBulk } from "./modules/staged_upload";
import { publicarProductosBulk } from "./modules/publish"
async function main() {
    const PATH_CSV = `./temp_productos.csv`;
    const PATH_BULK = `./temp_bulk.jsonl`;

    try {
        // PASO 1: DESCARGA
        console.log("Descarga")
        await downloadCSV(PATH_CSV);
        // PASO 2: PARSEO
        console.log("Parsea")
        const data = await processCSV(PATH_CSV);

        // PASO 3: GENERACION DE ARCHIVO BULK
        await generateBulkFile(data, PATH_BULK);

        // PASO 4: SUBIR ARCHIVO A SHOPIFY
        const bulkId = await subirArchivoShopify(PATH_BULK);
        // PASO 5: VIGILAR OPERACION
        await vigilarOperacion(bulkId);
        await verErroresBulk(bulkId);

        // PASO 6: UNA VEZ REALIZADA LA OPERACION, PUBLICAR LOS PRODUCTOS EN TODOS LOS CANALES DE VENTA
        console.log("Publicando")
        await publicarProductosBulk(bulkId);

    } catch (error) {
        console.error(error);
    } finally {
        // PASO 6: LIMPIEZA
        console.log("Limpiando archivos temporales");
        await Bun.file(PATH_CSV).delete();
        await Bun.file(PATH_BULK).delete();
    }
}

main();