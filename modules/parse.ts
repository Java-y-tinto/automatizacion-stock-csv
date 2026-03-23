import { file } from 'bun';
import Papa from 'papaparse';
import type { CSVRow } from './generateBulkFile';

function cleanTitle(raw: string): string {
    return (raw.split(/[\r\n]/)[0] ?? '')
        .replace(/;/g, ' - ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function toCSVRow(row: Record<string, string>): CSVRow {
    return {
        ...row,
        id: row['id'] ?? '',
        title: row['title'] ?? '',
        price: row['price'] ?? '0',
        sale_price: row['sale_price'] ?? row['price'] ?? '0',
        stock: row['stock'] ?? '0',
        image_link: row['image_link'],
        DESCRIPTION: row['DESCRIPTION'],
    };
}

async function processCSV(path: string): Promise<CSVRow[]> {
    console.log("Parseando CSV...");
    const csvRaw = await file(path).text();

    const { data, errors } = Papa.parse<Record<string, string>>(csvRaw, {
        header: true,
        delimiter: ';',
        skipEmptyLines: true,
        quoteChar: '"',
        transformHeader: (h) => h.trim().replace(/^\uFEFF/, ''),
    });

    if (errors.length) {
        console.warn(`⚠️ PapaParse reportó ${errors.length} avisos de formato. Se intentará continuar.`);
    }

    console.log("Limpiando saltos de línea y corrigiendo títulos...");

    const datosLimpios: CSVRow[] = data
        .map((row) => {
            const cleanRow: Record<string, string> = {};

            for (const key in row) {
                const value = row[key];
                cleanRow[key] = typeof value === 'string'
                    ? value.replace(/[\r\n]+/g, ' ').replace(/;/g, ' - ').trim()
                    : String(value ?? '');
            }

            cleanRow['title'] = cleanTitle(row['DESCRIPTION'] ?? '');

            return toCSVRow(cleanRow);
        })
        .filter((row) => row.title.length > 0);

    // CSV DE DEPURACIÓN
    const debugPath = './debug_limpio.csv';
    const debugCsv = Papa.unparse(datosLimpios, { delimiter: ';' });
    await Bun.write(debugPath, '\uFEFF' + debugCsv);
    console.log(`[OK] Archivo de depuración guardado en: ${debugPath}`);

    return datosLimpios;
}

export default processCSV;