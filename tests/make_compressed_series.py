"""Creates compressed variants of the phantom DICOM series using INDEPENDENT encoders (imagecodecs / pydicom) and
verifies them with an independent decoder (pydicom + pylibjpeg-libjpeg) before the JS decoder is tested on them.
Requires the venv in tests/out/venv (imagecodecs, pydicom, pylibjpeg, pylibjpeg-libjpeg) and `node tests/make_sample_dicom.js` first."""
import glob, os, sys
import numpy as np, pydicom, imagecodecs
from pydicom.encaps import encapsulate, fragment_frame
from pydicom.uid import JPEGLosslessSV1, JPEGLossless, RLELossless, ExplicitVRLittleEndian

here = os.path.dirname(os.path.abspath(__file__))
src = sorted(glob.glob(os.path.join(here, 'out', 'phantom_dicom', '*.dcm')))
assert src, 'run node tests/make_sample_dicom.js first'

def write(ds, path):
    ds.save_as(path, enforce_file_format=False)

def variant(name, fn):
    out = os.path.join(here, 'out', name); os.makedirs(out, exist_ok=True)
    for i, p in enumerate(src):
        ds = pydicom.dcmread(p)
        fn(ds, i)
        write(ds, os.path.join(out, 'IM%04d.dcm' % (i + 1)))
    print('wrote', name, len(src))

def ljpeg70(ds, i):        # uint16, 16-bit precision, predictor chosen by imagecodecs, 3 fragments + basic offset table
    a = ds.pixel_array.astype('<u2')
    frame = imagecodecs.ljpeg_encode(a)
    ds.PixelData = encapsulate([frame], fragments_per_frame=3, has_bot=True)
    ds['PixelData'].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = JPEGLosslessSV1
def ljpeg57_signed12(ds, i):  # signed 12-bit stored, slope 1 / intercept 0, JPEG Lossless Process 14 TS UID, multi-fragment, no BOT
    hu = ds.pixel_array.astype(np.int32) + int(ds.RescaleIntercept)       # HU
    raw = (hu & 0xFFF).astype('<u2')                                       # 12-bit two's complement bit pattern
    ds.PixelRepresentation = 1; ds.BitsStored = 12; ds.HighBit = 11; ds.RescaleIntercept = 0; ds.RescaleSlope = 1
    frame = imagecodecs.ljpeg_encode(raw, bitspersample=12)
    ds.PixelData = encapsulate([frame], fragments_per_frame=4, has_bot=False)
    ds['PixelData'].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = JPEGLossless
def rle(ds, i):
    ds.compress(RLELossless)

variant('phantom_ljpeg70', ljpeg70)
variant('phantom_ljpeg57_signed12', ljpeg57_signed12)
variant('phantom_rle', rle)

# JPEG Baseline (1.2.840.10008.1.2.4.50): 8-bit, quality 95, 8-bit stored (value = stored/16), reference = libjpeg-turbo decode (sidecar .raw)
from pydicom.uid import JPEGBaseline8Bit
refdir = os.path.join(here, 'out', 'phantom_baseline8_ref'); os.makedirs(refdir, exist_ok=True)
def baseline8(ds, i):
    a = np.clip(ds.pixel_array.astype(np.int32) // 16, 0, 255).astype(np.uint8)
    frame = imagecodecs.jpeg8_encode(a, level=95, colorspace='GRAY', outcolorspace='GRAY')
    open(os.path.join(refdir, 'IM%04d.raw' % (i + 1)), 'wb').write(imagecodecs.jpeg8_decode(frame).astype(np.uint8).tobytes())
    ds.BitsAllocated = 8; ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0
    ds.RescaleSlope = 16; ds.RescaleIntercept = -1024
    ds.PixelData = encapsulate([frame], has_bot=True); ds['PixelData'].is_undefined_length = True
    ds.file_meta.TransferSyntaxUID = JPEGBaseline8Bit
variant('phantom_baseline8', baseline8)

# independent verification of what we wrote (pydicom RLE decoder + libjpeg decoder)
orig = np.stack([pydicom.dcmread(p).pixel_array for p in src[::20]]).astype(np.int32)
for name, off in (('phantom_ljpeg70', 0), ('phantom_ljpeg57_signed12', None), ('phantom_rle', 0)):
    fs = sorted(glob.glob(os.path.join(here, 'out', name, '*.dcm')))[::20]
    arrs = []
    for f in fs:
        d = pydicom.dcmread(f); a = d.pixel_array.astype(np.int32)
        if name.endswith('signed12'): a = a + 1024     # compare as unsigned-with-intercept form: HU+1024
        arrs.append(a)
    ok = np.array_equal(np.stack(arrs), orig)
    print('independent decode check', name, 'identical to original:', ok)
    if not ok: sys.exit(1)
