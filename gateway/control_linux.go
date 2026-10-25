//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func (s *Server) startControlSocket() error {
	if s.config.ControlSocket == "" {
		return nil
	}
	path := filepath.Clean(s.config.ControlSocket)
	if err := removeStaleControlSocket(path); err != nil {
		return err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("listen on configured control socket: %w", err)
	}
	unixListener, ok := listener.(*net.UnixListener)
	if !ok {
		_ = listener.Close()
		return errors.New("configured control listener is not Unix")
	}
	unixListener.SetUnlinkOnClose(false)
	info, err := os.Lstat(path)
	if err != nil {
		_ = listener.Close()
		return fmt.Errorf("inspect control socket: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if info.Mode()&os.ModeSocket == 0 || !ok || int(stat.Uid) != os.Getuid() {
		_ = listener.Close()
		return errors.New("new control socket path is not an owned socket")
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		_ = removeOwnedSocket(path, info)
		return fmt.Errorf("set control socket permissions: %w", err)
	}
	currentInfo, err := os.Lstat(path)
	if err != nil || !os.SameFile(info, currentInfo) {
		_ = listener.Close()
		_ = removeOwnedSocket(path, info)
		if err != nil {
			return fmt.Errorf("inspect control socket: %w", err)
		}
		return errors.New("control socket path changed during setup")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", s.controlStatus)
	mux.HandleFunc("POST /quiesce", s.controlQuiesce)
	mux.HandleFunc("DELETE /quiesce", s.controlResume)
	s.controlListener = listener
	s.controlServer = &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	s.controlPath = path
	s.controlInfo = info
	socketPath := path
	socketInfo := info
	go func() {
		_ = s.controlServer.Serve(listener)
		_ = removeOwnedSocket(socketPath, socketInfo)
	}()
	return nil
}

func removeStaleControlSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing control socket: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return errors.New("configured control socket path exists and is not a socket")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("existing control socket is not owned by this user")
	}
	conn, dialErr := net.DialTimeout("unix", path, 200*time.Millisecond)
	if dialErr == nil {
		_ = conn.Close()
		return errors.New("configured control socket is already active")
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) {
		return fmt.Errorf("cannot safely determine whether existing control socket is active: %w", dialErr)
	}
	return removeOwnedSocket(path, info)
}

func removeOwnedSocket(path string, expected os.FileInfo) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return errors.New("refusing to remove a non-socket control path")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("refusing to remove a control socket owned by another user")
	}
	if expected != nil && !os.SameFile(expected, info) {
		return errors.New("control socket path changed during shutdown")
	}
	return os.Remove(path)
}

func (s *Server) shutdownControl(ctx context.Context) {
	if s.controlServer == nil {
		return
	}
	if err := s.controlServer.Shutdown(ctx); err != nil {
		_ = s.controlServer.Close()
	}
	if s.controlListener != nil {
		_ = s.controlListener.Close()
	}
	_ = removeOwnedSocket(s.controlPath, s.controlInfo)
}
