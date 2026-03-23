import { write } from "bun";


// Descarga el CSV de la URL proporcionada en el archivo .env
async function downloadCSV(destino: string) {
    const URL = process.env.CSV_DOWNLOAD!;
    console.log("Descargando archivo CSV");
    const response = await fetch(URL);

    if (!response.ok) throw new Error(`Error al descargar el archivo CSV: ${response.status}`);

    await write(destino, response);
    console.log("CSV descargado correctamente")
}

export default downloadCSV;