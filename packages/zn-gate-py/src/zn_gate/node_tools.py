"""Whether the Node.js tools are on this computer: the npm package commands run through npx."""
import shutil


def node_available() -> bool:
    """True when both node and npx are found on the PATH. The Python CLI prints the npx form
    of a next step only then; without Node.js it prints a step the Python package can follow alone."""
    return shutil.which("node") is not None and shutil.which("npx") is not None
