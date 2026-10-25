//go:build !linux

package main

import (
	"context"
	"errors"
)

func (s *Server) startControlSocket() error {
	if s.config.ControlSocket == "" {
		return nil
	}
	return errors.New("PROPRIUM_CONTROL_SOCKET is supported only on Linux")
}

func (s *Server) shutdownControl(context.Context) {}
