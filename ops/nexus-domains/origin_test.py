# Unit check of valid_origin in the patched copy. Usage: python3 origin_test.py <release dir>
import os, sys, importlib
sys.path.insert(0, sys.argv[1])
os.environ.pop('NEXUS_ENV', None)
os.environ['NEXUS_PUBLIC_ORIGIN'] = 'https://nexuslink.fit'
os.environ['NEXUS_EXTRA_PUBLIC_ORIGINS'] = 'https://nexusbooking.one, https://nexusapp.one,http://plain.example,'
ident = importlib.import_module('nexus_identity')
cases = [
  ('https://nexuslink.fit', True), ('https://nexusbooking.one', True), ('https://nexusapp.one', True),
  ('https://www.nexusbooking.one', False), ('http://nexusbooking.one', False), ('http://plain.example', False),
  ('https://nexusbooking.one.evil.example', False), ('https://evil.example', False), ('', False), ('null', False),
  ('https://nexusbooking.one/', False),
]
bad = 0
for origin, want in cases:
    got = ident.valid_origin(origin, 'x')
    if got != want: bad += 1
    print('ok  ' if got == want else 'FAIL', repr(origin), '->', got)
os.environ['NEXUS_EXTRA_PUBLIC_ORIGINS'] = ''
for origin, want in [('https://nexuslink.fit', True), ('https://nexusbooking.one', False)]:
    got = ident.valid_origin(origin, 'x'); bad += got != want
    print('ok  ' if got == want else 'FAIL', 'without extra origins', repr(origin), '->', got)
print('ALL PASSED' if not bad else f'{bad} FAILED'); sys.exit(1 if bad else 0)
