# 에이전트 지침

## 프로젝트 개요

Apple Silicon(aarch64-darwin) macOS의 dotfiles를 **nix-darwin**, **home-manager**, **nix-homebrew**로 관리한다.

## 파일 구조

- `flake.nix` — 시스템 패키지, macOS 기본 설정, Homebrew(brews/casks/masApps), nix-darwin 설정을 정의하는 메인 flake
- `home.nix` — 사용자 프로그램(zsh, git, vim) 설정과 `mkOutOfStoreSymlink`를 이용한 dotfile 심볼릭 링크를 관리하는 home-manager 설정
- `zshrc` — home-manager의 `initContent`로 불러오는 Zsh 설정. 별칭, 환경 변수, mise 활성화 설정 포함
- `karabiner.json` — Karabiner Elements 설정. home-manager를 통해 `~/.config/karabiner/`에 심볼릭 링크로 연결
- `mise/` — Node.js, Python, Ruby, Java, Terraform, CocoaPods의 전역 mise 버전 설정
- `packages/python/<name>/` — uv2nix로 관리하는 Python CLI 패키지의 Nix 정의, `pyproject.toml`, `uv.lock`
- `packages/node/<name>/` — `buildNpmPackage`와 `importNpmLock`으로 관리하는 npm CLI 패키지의 Nix 정의, `package.json`, `package-lock.json`
- `codex/` — CLI의 `dev` 프로필과 MCP 서버 설정을 `config.toml`에서 관리하고 `~/.codex/dev.config.toml`에 연결. `cdx` 별칭으로 프로필과 승인·샌드박스 우회 옵션을 함께 사용하며, `agents/`는 `~/.codex/agents/`에 디렉터리 단위로 연결
- `flake.lock` — flake 입력의 버전을 고정하는 파일. 직접 수정하지 않는다.

## 업데이트 및 변경 사항 적용

`zshrc`에 정의된 별칭을 사용한다.

```zsh
# flake 입력을 최신 버전으로 업데이트하고 flake.lock 갱신
nxu

# mbp 구성을 빌드하고 시스템에 적용
nxr
```

각 별칭의 실제 명령은 다음과 같다. 별칭을 사용할 수 없는 셸에서는 직접 실행한다.

```sh
# nxu
nix flake update --flake ~/.dotfiles

# nxr
sudo darwin-rebuild switch --flake ~/.dotfiles#mbp
```

패키지와 flake 의존성을 업데이트해 적용하려면 `nxu` 실행 후 `nxr`을 실행한다. 설정 변경만 적용하려면 `nxr`을 실행한다.

## Python CLI 패키지 관리

Python CLI 패키지는 `packages/python/<name>/`에서 uv로 의존성을 관리하고 uv2nix로 Nix 패키지를 생성한다. Nix 입력은 루트 `flake.lock`, Python 패키지와 전이 의존성은 각 패키지의 `uv.lock`으로 고정한다. 패키지는 `flake.nix`의 `environment.systemPackages`에 추가한다.

직접 사용하는 Python은 mise로 관리한다. Nix 패키지 실행에 필요한 Python은 내부 의존성으로만 포함하고 전역 `python` 명령으로 노출하지 않는다.

버전을 업데이트할 때는 `pyproject.toml`의 의존성 버전을 수정한 뒤, 해당 파일의 `requires-python`을 만족하는 mise Python이 활성화된 셸에서 `uv.lock`을 다시 생성하고 빌드한다. browser-use는 Python 3.13을 사용하며, 저장소 루트에서 다음과 같이 실행한다.

```sh
uv lock --project packages/python/browser-use --python "$(mise which python)" --no-python-downloads
nix build .#browser-use
```

uv가 별도로 관리하는 Python을 선택하지 않도록 `mise which python`의 실제 경로를 지정한다. `uv.lock`은 직접 편집하지 않는다. `nxu`는 Nix 입력을 갱신하므로 Python 의존성 잠금은 위 절차로 별도 갱신한다. 검증 후 `nxr`로 시스템에 적용한다.

## npm CLI 패키지 관리

Corepack은 `flake.nix`의 `environment.systemPackages`로 설치한다. Nix 패키지에 `pnpm`, `pnpx`, `yarn` 실행 명령이 포함되어 있으므로 별도의 `corepack enable`이나 `npm install -g pnpm`은 필요하지 않다. 프로젝트의 패키지 매니저 버전은 `package.json`의 `packageManager`로 지정하며, 해당 버전의 다운로드와 캐시는 Corepack이 관리한다. 직접 사용하는 Node 버전은 mise로 관리한다.

npm CLI 패키지는 `packages/node/<name>/package.json`에서 버전을 고정하고, npm으로 `package-lock.json`을 생성한다. `buildNpmPackage`로 패키징하며 `importNpmLock`이 lock 파일의 무결성 해시로 의존성을 가져온다. 실행에 필요한 Node는 패키지 내부 의존성으로 포함하고, 직접 사용하는 Node 버전은 mise로 관리한다.

버전 변경 후 해당 패키지 폴더에서 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`로 lock 파일을 갱신한다. `package-lock.json`은 직접 편집하지 않는다. 저장소 루트에서 `nix build .#codex-auth`로 빌드·버전을 검증하고, `nxr`로 시스템에 적용한다.

## 작업 규칙

- CLI 도구는 nix(`flake.nix`의 `environment.systemPackages`)로 설치해 `flake.lock`으로 버전을 고정하고 롤백할 수 있게 한다. 프로젝트마다 버전이 달라지는 런타임과 도구는 mise로 관리한다. Homebrew는 GUI 앱(`homebrew.casks`)과 Mac App Store 자동화(`mas`)에 사용한다.
- Mac App Store 앱은 `homebrew.masApps`에 추가한다. 형식은 `이름 = App Store ID`이다.
- dotfile 설정이 있는 사용자 프로그램은 `home.nix`의 `programs.<name>`으로 관리한다.
- 필요한 MCP 서버는 `codex/config.toml`의 `[mcp_servers.<name>]`에 직접 추가한다. 이 저장소에서 관리하는 MCP 설정은 `codex mcp add`로 계정별 설정에 별도 등록하지 않는다.
- 이 저장소의 dotfile은 복사하지 않고 `mkOutOfStoreSymlink`로 연결하므로 원본 파일의 수정이 연결된 경로에 즉시 반영된다.
- Nix 파일은 `nixfmt`으로 포맷한다.
- 머신 구성 이름은 `mbp`(`darwinConfigurations.mbp`)이다.
