.PHONY: dev-backend test-backend build-gateway science-venv

dev-backend:            ## run science on :8091 and gateway on :8080
	scripts/dev.sh

build-gateway:
	cd gateway && go build -o bin/gateway .

science-venv:
	~/.local/bin/uv venv --python 3.12 science/.venv
	~/.local/bin/uv pip install --python science/.venv/bin/python -r science/requirements.txt

test-backend:           ## unit tests (low parallelism)
	cd gateway && go test -p 1 -count=1 ./...
