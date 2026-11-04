"""Run with python3 server.py. No installation or environment setup required."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
from website_js_extractor.receiver import main

if __name__ == '__main__':
    raise SystemExit(main())
