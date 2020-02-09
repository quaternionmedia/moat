from  fastapi import FastAPI
from uvicorn import run

app = FastAPI()

@app.get('/')
async def index():
    return 'sup!'
