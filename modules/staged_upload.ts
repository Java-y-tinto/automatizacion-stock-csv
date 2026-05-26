import { graphql } from "../functions";

export async function subirArchivoShopify(path: string) {
  const stat = Bun.file(path);
  const nombreArchivo = path.split('/').pop();
  if (!nombreArchivo) throw new Error("No se pudo obtener el nombre del archivo");

  // Pedimos permiso a shopify para subir el archivo
  const queryStaged = `
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
          }
        }
  `;

  const stagedData = await graphql(queryStaged, {
    input: [{
      filename: nombreArchivo,
      mimeType: "text/jsonl",
      resource: "BULK_MUTATION_VARIABLES",
      fileSize: stat.size.toString()
    }]
  });

  const target = stagedData.stagedUploadsCreate.stagedTargets[0];
  console.log("target parameters:", target.parameters)
  // Subida fisica
  console.log("target.url:", target.url)
  const uploadResponse = await fetch(target.url, {
    method: 'PUT',
    headers: {
      'Content-type': 'text/jsonl',
      'Content-Length': stat.size.toString()
    },
    body: stat
  });

  if (!uploadResponse.ok) throw new Error(`Error al subir el archivo ${await uploadResponse.text()}`);

  console.log("Archivo subido correctamente");

  // Ejecutamos el bulk mutation

  const mutationBulk = `
        mutation bulkOperationRunMutation($stagedUploadPath: String!) {
          bulkOperationRunMutation(
            stagedUploadPath: $stagedUploadPath,
            mutation: "mutation productSet($input: ProductSetInput!) { productSet(input: $input) { product { id } userErrors { field message } } }"
          ) {
            bulkOperation { id status }
            userErrors { field message }
          }
        }
    `;

  const bulkResult = await graphql(mutationBulk, {
    stagedUploadPath: target.resourceUrl
  });

  if (bulkResult.bulkOperationRunMutation.userErrors.length > 0) {
    throw new Error(`Errores de Shopify: ${JSON.stringify(bulkResult.bulkOperationRunMutation.userErrors)}`);
  }

  console.log("Bulk ejecutado correctamente");
  return bulkResult.bulkOperationRunMutation.bulkOperation.id;




}

export async function consultarEstadoPorId(id: string) {
  const query = `
        query ($id: ID!) {
          node(id: $id) {
            ... on BulkOperation {
              id
              status
              errorCode
              objectCount
            }
          }
        }
    `;

  const data = await graphql(query, { id });
  return data.node; // Esto nos devuelve el objeto BulkOperation con su estado
}

export async function vigilarOperacion(bulkId: string) {
  console.log(`\nVigilando operación: ${bulkId}`);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  let terminado = false;

  while (!terminado) {
    try {
      const op = await consultarEstadoPorId(bulkId);

      if (!op) {
        console.log("No se encuentra la información del ID aún...");
        await sleep(2000);
        continue;
      }

      console.log(`[${new Date().toLocaleTimeString()}] Estado: ${op.status} | Procesados: ${op.objectCount}`);

      if (op.status === "COMPLETED") {
        console.log("\n ¡Sincronización finalizada con éxito!");
        terminado = true;
      } else if (op.status === "FAILED" || op.status === "CANCELED") {
        console.error(`\nError: ${op.errorCode || 'Operación cancelada'}`);
        terminado = true;
      } else {
        // Sigue en marcha (CREATED o RUNNING)
        await sleep(3000);
      }
    } catch (error: any) {
      console.error("error consultando estado:", error.message);
      await sleep(3000);
    }
  }
}

export async function verErroresBulk(bulkOperationId: string) {
  const query = `
        query {
            node(id: "${bulkOperationId}") {
                ... on BulkOperation {
                    status
                    errorCode
                    url
                }
            }
        }
    `;

  const respuesta = await graphql(query);
  const operacion = respuesta.node;

  if (operacion.url) {
    // Descargar el contenido
    const response = await fetch(operacion.url);
    const text = await response.text();

    // 1. Guardar el archivo físicamente en disco
    const nombreArchivo = `resultados_bulk_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    await Bun.write(nombreArchivo, text);
    console.log(`[OK] Archivo descargado y guardado como: ${nombreArchivo}`);

    // 2. Filtrar y mostrar errores en consola
    const lineas = text.split('\n').filter(line => line.trim() !== '');
    const errors = lineas.filter(line => {
      try {
        const json = JSON.parse(line);
        return json.data?.productSet?.userErrors?.length > 0;
      } catch {
        return false;
      }
    });

    if (errors.length > 0) {
      console.log(`\n Se encontraron ${errors.length} líneas con errores:`);
      console.log(errors);
    } else {
      console.log("\n El archivo no contiene errores. Operación limpia.");
    }

  } else {
    console.log("No hay URL de resultados disponible. Estado:", operacion.status);
  }
}



export async function subirImagenShopify(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`No se pudo descargar la imagen: ${response.status}`);

  const buffer = await response.arrayBuffer();
  const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
  const filename = imageUrl.split('/').pop()?.split('?')[0] ?? 'image.jpg';
  const fileSize = buffer.byteLength;

  const queryStaged = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
        }
      }
  `;

  const stagedData = await graphql(queryStaged, {
    input: [{
      filename,
      mimeType,
      resource: "FILE",
      fileSize: fileSize.toString()
    }]
  });

  const target = stagedData.stagedUploadsCreate.stagedTargets[0];

  const uploadResponse = await fetch(target.url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'Content-Length': fileSize.toString()
    },
    body: buffer
  });

  if (!uploadResponse.ok) throw new Error(`Error al subir imagen a Shopify: ${await uploadResponse.text()}`);

  return target.resourceUrl;
}

// Shopify es especialito y requiere una subida aparte para publicar los productos en los canales de venta
export async function subirArchivoPublicacionShopify(path: string) {
  const stat = Bun.file(path);
  const nombreArchivo = path.split('/').pop();
  if (!nombreArchivo) throw new Error("No se pudo obtener el nombre del archivo");

  const queryStaged = `
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
          }
        }
  `;

  const stagedData = await graphql(queryStaged, {
    input: [{
      filename: nombreArchivo,
      mimeType: "text/jsonl",
      resource: "BULK_MUTATION_VARIABLES",
      fileSize: stat.size.toString()
    }]
  });

  const target = stagedData.stagedUploadsCreate.stagedTargets[0];

  const uploadResponse = await fetch(target.url, {
    method: 'PUT',
    headers: {
      'Content-type': 'text/jsonl',
      'Content-Length': stat.size.toString()
    },
    body: stat
  });

  if (!uploadResponse.ok) throw new Error(`Error al subir el archivo ${await uploadResponse.text()}`);

  // Aquí cambiamos la mutación a publishablePublish
  const mutationBulk = `
        mutation bulkOperationRunMutation($stagedUploadPath: String!) {
          bulkOperationRunMutation(
            stagedUploadPath: $stagedUploadPath,
            mutation: "mutation call($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }"
          ) {
            bulkOperation { id status }
            userErrors { field message }
          }
        }
    `;

  const bulkResult = await graphql(mutationBulk, {
    stagedUploadPath: target.resourceUrl
  });

  if (bulkResult.bulkOperationRunMutation.userErrors.length > 0) {
    throw new Error(`Errores de Shopify: ${JSON.stringify(bulkResult.bulkOperationRunMutation.userErrors)}`);
  }

  return bulkResult.bulkOperationRunMutation.bulkOperation.id;
}