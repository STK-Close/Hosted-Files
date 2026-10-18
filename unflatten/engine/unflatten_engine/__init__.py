"""Unflatten separation engine: one flattened image in, named RGBA layers out."""
from .pipeline import Engine, unflatten
from .types import Layer, Result

__all__ = ["Engine", "unflatten", "Layer", "Result"]
__version__ = "0.1.0"
