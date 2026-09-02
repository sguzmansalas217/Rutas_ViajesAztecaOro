// Quién es el proveedor del servicio.
//
// No es un rol de la base a propósito. El cliente tiene su propio
// administrador —es su sistema y da de alta a su gente— y si esto colgara del
// rol, el día que se le da 'admin' al cliente se le abre de paso el costo de
// operación: lo que se le paga a Meta, el tipo de cambio, el margen. El
// proveedor es una sola cuenta, la del ADMIN_CORREO del .env, la del
// despliegue, y ésa no se administra desde el portal.
import { config } from '../config.js';

export function esProveedor(req) {
  const proveedor = (config.admin.correo ?? '').trim().toLowerCase();
  // Sin ADMIN_CORREO no hay proveedor y no lo ve nadie: es el lado seguro.
  if (!proveedor) return false;
  return req.user?.correo?.trim().toLowerCase() === proveedor;
}
