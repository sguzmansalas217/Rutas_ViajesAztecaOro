# Saca el logotipo del cliente de su fondo.
#
# El JPG original viene sobre un viñeteado gris que va de casi negro en las
# esquinas a un halo cálido en el centro. Puesto tal cual sobre el panel oscuro
# del login se ve el recuadro del JPG, así que hay que separarlo.
#
# No se puede resolver con un solo umbral: el halo del centro es tan claro como
# el disco blanco. Se hace en dos partes, que es como está construido el logo:
#
#   1. El disco (el calendario rojo sobre blanco) es un círculo limpio —se
#      detecta por geometría y se toma entero.
#   2. El texto "Viajes Azteca" es amarillo y sale muy fuera del disco. Se
#      aísla por color: g-b separa el amarillo del gris del fondo, que es
#      neutro incluso donde está más iluminado.
#
# Los bordes antialiasados del texto son mezcla de amarillo y gris; se
# desmezclan contra el gris del fondo para que no queden con halo sucio.
from PIL import Image, ImageFilter
import sys, pathlib

ORIGEN = pathlib.Path(sys.argv[1])
DESTINO = pathlib.Path(sys.argv[2])
LADO = int(sys.argv[3]) if len(sys.argv) > 3 else 360

im = Image.open(ORIGEN).convert('RGB')
w, h = im.size
px = im.load()

FONDO = (39, 39, 39)          # gris de las esquinas, medido del propio archivo
CX, CY, R = 227.0, 254.0, 150.0   # disco, medido del propio archivo

alfa = Image.new('L', (w, h), 0)
ap = alfa.load()
salida = Image.new('RGB', (w, h), FONDO)
sp = salida.load()


def recorta(v):
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        d = ((x - CX) ** 2 + (y - CY) ** 2) ** 0.5

        if d <= R:
            a = 1.0
        elif d <= R + 2:                      # dos píxeles de transición
            a = 1.0 - (d - R) / 2.0
        else:
            # Fuera del disco sólo sobrevive lo amarillo. El fondo es neutro
            # (g-b ≈ 5 hasta en el halo), el texto pasa de 60.
            amarillo = recorta((g - b - 14) / 42.0)
            brillo = recorta(((0.299 * r + 0.587 * g + 0.114 * b) - 46) / 70.0)
            a = amarillo * brillo

        ap[x, y] = int(round(a * 255))
        if a >= 0.999 or a <= 0.0:
            sp[x, y] = (r, g, b)
        else:
            # Desmezcla: el píxel es a*color + (1-a)*fondo. Se despeja color.
            sp[x, y] = tuple(
                max(0, min(255, int(round((c - f * (1 - a)) / a))))
                for c, f in zip((r, g, b), FONDO)
            )

# Un desenfoque mínimo del canal alfa quita el dentado que deja el umbral.
alfa = alfa.filter(ImageFilter.GaussianBlur(0.6))
salida.putalpha(alfa)
salida = salida.resize((LADO, LADO), Image.LANCZOS)
DESTINO.parent.mkdir(parents=True, exist_ok=True)
salida.save(DESTINO, optimize=True)
print(f'{DESTINO}  {LADO}x{LADO}  {DESTINO.stat().st_size // 1024} KB')
