package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/moby/buildkit/client/llb"
	"github.com/moby/buildkit/client/llb/sourceresolver"
	"github.com/moby/buildkit/exporter/containerimage/exptypes"
	"github.com/moby/buildkit/frontend/gateway/client"
	"github.com/moby/buildkit/frontend/gateway/grpcclient"
	"github.com/moby/buildkit/solver/pb"
	"github.com/moby/buildkit/util/appcontext"
	"github.com/moby/buildkit/util/bklog"
	_ "github.com/moby/buildkit/util/grpcutil/encoding/proto"
	ocispecs "github.com/opencontainers/image-spec/specs-go/v1"
)

const inputOption = "scriptorium.build-input.v1"

var digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var revisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var repositoryPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$`)

type moduleIdentity struct {
	ID             string `json:"id"`
	Version        string `json:"version"`
	ArtifactDigest string `json:"artifactDigest"`
}

type buildInput struct {
	ContractVersion   string           `json:"contractVersion"`
	ProducerRevision  string           `json:"producerRevision"`
	RuntimeBaseDigest string           `json:"runtimeBaseDigest"`
	BuildKitDigest    string           `json:"buildKitDigest"`
	RecipeDigest      string           `json:"recipeDigest"`
	SourceDigest      string           `json:"sourceDigest"`
	LockDigest        string           `json:"lockDigest"`
	RequestedModules  []string         `json:"requestedModules"`
	ResolvedModules   []moduleIdentity `json:"resolvedModules"`
	Platform          string           `json:"platform"`
	Options           map[string]any   `json:"options"`
}

func parseInput(encoded string) (buildInput, error) {
	var input buildInput
	if encoded == "" || len(encoded) > 96*1024 {
		return input, errors.New("missing or oversized Scriptorium build input")
	}
	bytes, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(bytes) != encoded {
		return input, errors.New("invalid Scriptorium build input encoding")
	}
	decoder := json.NewDecoder(strings.NewReader(string(bytes)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, fmt.Errorf("invalid Scriptorium build input: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return input, errors.New("trailing Scriptorium build input data")
	}
	if input.ContractVersion != "scriptorium-build/v1" || !revisionPattern.MatchString(input.ProducerRevision) ||
		!digestPattern.MatchString(input.RuntimeBaseDigest) || !digestPattern.MatchString(input.BuildKitDigest) ||
		!digestPattern.MatchString(input.RecipeDigest) || !digestPattern.MatchString(input.SourceDigest) ||
		!digestPattern.MatchString(input.LockDigest) || input.Platform != "linux/amd64" || input.Options == nil ||
		input.RequestedModules == nil || input.ResolvedModules == nil || len(input.Options) != 0 {
		return input, errors.New("unsupported Scriptorium build input values")
	}
	return input, nil
}

func build(ctx context.Context, gateway client.Client) (*client.Result, error) {
	options := gateway.BuildOpts().Opts
	encodedInput := options[inputOption]
	input, err := parseInput(encodedInput)
	if err != nil {
		return nil, err
	}
	frontendRef := options["source"]
	separator := strings.LastIndexByte(frontendRef, '@')
	if separator <= 0 || frontendRef[separator+1:] != input.BuildKitDigest || !repositoryPattern.MatchString(frontendRef[:separator]) {
		return nil, errors.New("BuildKit source must be the immutable image bound by BuildInput")
	}
	frontendRepository := frontendRef[:separator]
	platform := ocispecs.Platform{OS: "linux", Architecture: "amd64"}
	_, resolvedDigest, frontendConfig, err := gateway.ResolveImageConfig(ctx, frontendRef, sourceresolver.Opt{
		ImageOpt: &sourceresolver.ResolveImageOpt{Platform: &platform},
	})
	if err != nil {
		return nil, fmt.Errorf("resolve immutable Build Kit image: %w", err)
	}
	if resolvedDigest.String() != input.BuildKitDigest {
		return nil, errors.New("resolved Build Kit image digest differs from BuildInput")
	}
	var frontendImage ocispecs.Image
	if err := json.Unmarshal(frontendConfig, &frontendImage); err != nil {
		return nil, errors.New("Build Kit image configuration is invalid")
	}
	if imageEnv(frontendImage.Config.Env, "SCRIPTORIUM_PRODUCER_REVISION") != input.ProducerRevision {
		return nil, errors.New("Build Kit image producer revision differs from BuildInput")
	}
	frontendClient, ok := gateway.(interface {
		CurrentFrontend() (*llb.State, error)
	})
	if !ok {
		return nil, errors.New("Build Kit gateway does not expose its immutable frontend source")
	}
	frontend, err := frontendClient.CurrentFrontend()
	if err != nil || frontend == nil {
		if err == nil {
			err = errors.New("Build Kit frontend root filesystem is missing")
		}
		return nil, err
	}
	buildState, err := frontend.WithImageConfig(frontendConfig)
	if err != nil {
		return nil, fmt.Errorf("apply immutable Build Kit image configuration: %w", err)
	}
	buildOutput := buildState.Dir("/opt/scriptorium").With(llb.Network(pb.NetMode_NONE)).Run(
		llb.Args([]string{"/usr/local/bin/node", "/opt/scriptorium/scripts/hosted-build.mjs", "compose", "--input-base64url", encodedInput, "--source", frontendRef}),
	).Root()

	runtimeRef := frontendRepository + "@" + input.RuntimeBaseDigest
	_, resolvedRuntimeDigest, runtimeConfigBytes, err := gateway.ResolveImageConfig(ctx, runtimeRef, sourceresolver.Opt{
		ImageOpt: &sourceresolver.ResolveImageOpt{Platform: &platform},
	})
	if err != nil {
		return nil, fmt.Errorf("resolve immutable Runtime Base image: %w", err)
	}
	if resolvedRuntimeDigest.String() != input.RuntimeBaseDigest {
		return nil, errors.New("resolved Runtime Base digest differs from BuildInput")
	}
	exportedImageConfig, err := hostedImageConfig(runtimeConfigBytes, input.ProducerRevision)
	if err != nil {
		return nil, fmt.Errorf("prepare hosted image configuration: %w", err)
	}
	runtime := llb.Image(runtimeRef, llb.WithMetaResolver(gateway), llb.Platform(platform))
	runtime = runtime.AddEnv("SCRIPTORIUM_HOSTED_MODE", "1").
		AddEnv("SCRIPTORIUM_PRODUCER_REVISION", input.ProducerRevision).
		AddEnv("SCRIPTORIUM_PROFILE", "hosted").
		AddEnv("SCRIPTORIUM_MODULE_PROFILE_PATH", "/app/generated/server.mjs").
		AddEnv("HOST", "0.0.0.0").
		AddEnv("PORT", "3000").
		AddEnv("SCRIPTORIUM_DATA_DIR", "/data").
		AddEnv("SCRIPTORIUM_USAGE_DIR", "/history").
		AddEnv("HOME", "/data")
	owner := llb.WithUIDGID(1000, 1000).(llb.ChownOpt)
	copyInfo := &llb.CopyInfo{CopyDirContentsOnly: true, CreateDestPath: true, FollowSymlinks: true, ChownOpt: &owner}
	runtime = runtime.File(llb.Copy(buildOutput, "/tmp/scriptorium-hosted-artifact/app", "/app", copyInfo))
	runtime = runtime.File(llb.Copy(buildOutput, "/tmp/scriptorium-hosted-artifact/usr/share/scriptorium", "/usr/share/scriptorium", copyInfo))

	definition, err := runtime.Marshal(ctx, llb.Platform(platform), llb.WithCaps(gateway.BuildOpts().Caps))
	if err != nil {
		return nil, fmt.Errorf("marshal hosted runtime image: %w", err)
	}
	result, err := gateway.Solve(ctx, client.SolveRequest{Definition: definition.ToPB()})
	if err != nil {
		return nil, fmt.Errorf("build hosted runtime image: %w", err)
	}
	ref, err := result.SingleRef()
	if err != nil {
		return nil, fmt.Errorf("read hosted runtime result: %w", err)
	}

	smokeTokenBytes := make([]byte, 32)
	if _, err := rand.Read(smokeTokenBytes); err != nil {
		return nil, fmt.Errorf("generate ephemeral startup smoke token: %w", err)
	}
	smoke := runtime.File(llb.Copy(*frontend, "/opt/scriptorium/scripts/hosted-smoke.mjs", "/usr/share/scriptorium/hosted-smoke.mjs", &llb.CopyInfo{CreateDestPath: true, ChownOpt: &owner})).
		AddEnv("HOST", "127.0.0.1").
		AddEnv("PORT", "34117").
		AddEnv("SCRIPTORIUM_HOSTED_MODE", "0").
		AddEnv("SCRIPTORIUM_AUTH_TOKEN", hex.EncodeToString(smokeTokenBytes)).
		AddEnv("SCRIPTORIUM_DATA_DIR", "/tmp/scriptorium-hosted-smoke/data").
		AddEnv("SCRIPTORIUM_USAGE_DIR", "/tmp/scriptorium-hosted-smoke/history").
		AddEnv("SCRIPTORIUM_MODULE_CACHE_DIR", "/tmp/scriptorium-hosted-smoke/module-cache").
		With(llb.User("node"), llb.Network(pb.NetMode_NONE)).
		Run(llb.Args([]string{"/usr/local/bin/node", "/usr/share/scriptorium/hosted-smoke.mjs"})).Root()
	smokeDefinition, err := smoke.Marshal(ctx, llb.Platform(platform), llb.WithCaps(gateway.BuildOpts().Caps))
	if err != nil {
		return nil, fmt.Errorf("marshal hosted runtime startup smoke: %w", err)
	}
	if _, err := gateway.Solve(ctx, client.SolveRequest{Definition: smokeDefinition.ToPB()}); err != nil {
		return nil, fmt.Errorf("run hosted runtime startup smoke: %w", err)
	}
	output := client.NewResult()
	output.SetRef(ref)
	output.AddMeta(exptypes.ExporterImageConfigKey, exportedImageConfig)
	return output, nil
}

func hostedImageConfig(encoded []byte, producerRevision string) ([]byte, error) {
	var image ocispecs.Image
	if err := json.Unmarshal(encoded, &image); err != nil {
		return nil, fmt.Errorf("Runtime Base image configuration is invalid: %w", err)
	}
	if image.OS != "linux" || image.Architecture != "amd64" || image.Config.WorkingDir != "/app" ||
		image.Config.User != "node" || !equalStrings(image.Config.Entrypoint, []string{"/usr/bin/tini", "--"}) ||
		!equalStrings(image.Config.Cmd, []string{"node", "launch.mjs"}) || !hasExposedPort(image.Config.ExposedPorts, "3000/tcp") ||
		imageEnv(image.Config.Env, "SCRIPTORIUM_PRODUCER_REVISION") != producerRevision {
		return nil, errors.New("Runtime Base image configuration does not match the required Scriptorium runtime contract")
	}
	for _, value := range []string{
		"SCRIPTORIUM_HOSTED_MODE=1",
		"SCRIPTORIUM_PRODUCER_REVISION=" + producerRevision,
		"SCRIPTORIUM_PROFILE=hosted",
		"SCRIPTORIUM_MODULE_PROFILE_PATH=/app/generated/server.mjs",
		"HOST=0.0.0.0",
		"PORT=3000",
		"SCRIPTORIUM_DATA_DIR=/data",
		"SCRIPTORIUM_USAGE_DIR=/history",
		"HOME=/data",
	} {
		name, _, _ := strings.Cut(value, "=")
		image.Config.Env = setImageEnv(image.Config.Env, name, value)
	}
	return json.Marshal(image)
}

func setImageEnv(values []string, key, replacement string) []string {
	updated := make([]string, 0, len(values)+1)
	for _, value := range values {
		name, _, ok := strings.Cut(value, "=")
		if !ok || name != key {
			updated = append(updated, value)
		}
	}
	return append(updated, replacement)
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func hasExposedPort(ports map[string]struct{}, expected string) bool {
	_, found := ports[expected]
	return found
}

func imageEnv(values []string, key string) string {
	for _, value := range values {
		name, data, ok := strings.Cut(value, "=")
		if ok && name == key {
			return data
		}
	}
	return ""
}

func main() {
	if err := grpcclient.RunFromEnvironment(appcontext.Context(), build); err != nil {
		bklog.L.Errorf("Scriptorium BuildKit frontend failed: %v", err)
		panic(err)
	}
}
