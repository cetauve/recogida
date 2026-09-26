# 26 septiembre 2026 - NO TOCAR api/tandas.js NI api/_lib.js

El 25 de septiembre se reescribieron estos dos ficheros (unos 20 commits en un dia)
y el servidor dejo de responder: /api/tandas devolvia "servidor-lento" para todos
los dias, de Espana y de Alemania.

Hoy 26 de septiembre se ha deshecho ese trabajo:

- api/tandas.js -> vuelto a la version del 24 sep (commit 3336e7c5)
- api/_lib.js   -> vuelto a la version del 8 sep  (commit 88657e6c)

Los cambios del 25 sep en app-directo.html y panel-directos.html se han dejado
como estaban, porque son pantallas y no causaron la caida.

## Estado despues de la vuelta atras

- /api/salud responde bien.
- /api/tandas del dia 24 sep responde bien y en menos de un segundo.
- /api/tandas de los dias 25 y 26 sep se queda colgado sin contestar.

O sea: el codigo ya no es el problema. Cuelga algo de los datos de esos dos dias.
Sospecha principal: el 25 se lanzaron prendas como productos individuales con
categoria y marca distintas, y por eso hay muchos productos repetidos numerados
del 1 al 18 en Espana.

## Instrucciones

SOLO DIAGNOSTICO. No subir cambios a api/tandas.js ni a api/_lib.js sin que Aaron
lo apruebe por escrito. No anadir tiempos de espera ni tocar la conexion a la base
de datos: eso es lo que rompio el servidor. Recordatorio: el plan de Vercel solo
admite 12 funciones y estan las 12 usadas, no se pueden crear ficheros nuevos
dentro de api/.
