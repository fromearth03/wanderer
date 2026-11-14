// Command gateway is the Wanderer API gateway: it talks to IRSA (SIA, IBE
// cutouts), JPL (sb_ident, Horizons) and CDS Sesame, caches everything on
// disk, limits concurrency against IRSA, runs long jobs and forwards all
// pixel work to the science service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const version = "1.1.0" // 1.1: /api/rgb, /api/rgb.png, /api/hips proxy

type Config struct {
	Port        string
	CacheDir    string
	ScienceURL  string
	CacheMaxMB  int64
	IRSAWorkers int
}

func loadConfig() Config {
	c := Config{
		Port:        env("PORT", "8080"),
		CacheDir:    env("CACHE_DIR", "./.cache"),
		ScienceURL:  env("SCIENCE_URL", "http://localhost:8091"),
		CacheMaxMB:  int64(envInt("CACHE_MAX_MB", 3000)),
		IRSAWorkers: envInt("IRSA_CONCURRENCY", 4),
	}
	if abs, err := filepath.Abs(c.CacheDir); err == nil {
		c.CacheDir = abs
	}
	return c
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}

func main() {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	cfg := loadConfig()
	app, err := NewApp(cfg)
	if err != nil {
		slog.Error("startup failed", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Cold cutouts can take a while (IRSA retries); each handler also has its own deadline.
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go app.cache.JanitorLoop(ctx, 10*time.Minute)
	if os.Getenv("WARM_PRESETS") != "0" {
		go func() {
			// give the science service a moment to come up
			for i := 0; i < 30 && !app.sci.Healthy(ctx); i++ {
				time.Sleep(2 * time.Second)
			}
			app.WarmPresets(ctx)
		}()
	}

	go func() {
		slog.Info("gateway listening", "port", cfg.Port, "cache", cfg.CacheDir, "science", cfg.ScienceURL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	slog.Info("gateway stopped")
}
