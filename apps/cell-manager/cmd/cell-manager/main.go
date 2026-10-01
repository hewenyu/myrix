// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0

// Command cell-manager runs the Myrix TenantCell controller.
//
// It is intentionally small: it watches TenantCell objects in one namespace
// (the Runtime namespace), owns the per-tenant StatefulSet/Service/PVC, and
// exposes a narrow internal API that the session router uses to request a
// wake. Leader election is on by default so that several replicas never
// reconcile the same cell twice.
package main

import (
	"errors"
	"flag"
	"net/http"
	"os"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	crlog "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/myrix/apps/cell-manager/api/v1alpha1"
	"github.com/myrix/apps/cell-manager/internal/apiserver"
	"github.com/myrix/apps/cell-manager/internal/controller"
	"github.com/myrix/apps/cell-manager/internal/driver"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(v1alpha1.AddToScheme(scheme))
}

func main() {
	var (
		metricsAddr          string
		probeAddr            string
		internalAddr         string
		internalCertFile     string
		internalKeyFile      string
		enableLeaderElection bool
		leaderElectionID     string
		runtimeNamespace     string
	)
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "Address for the metrics endpoint.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "Address for liveness/readiness probes.")
	flag.StringVar(&internalAddr, "internal-bind-address", ":8405", "Address for the internal wake API.")
	flag.StringVar(&internalCertFile, "internal-tls-cert-file", os.Getenv("MYRIX_INTERNAL_TLS_CERT_FILE"), "TLS certificate for the internal API. Empty serves plaintext HTTP, which is only acceptable in development or behind a mesh that terminates TLS.")
	flag.StringVar(&internalKeyFile, "internal-tls-key-file", os.Getenv("MYRIX_INTERNAL_TLS_KEY_FILE"), "TLS private key for the internal API.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election so only one replica reconciles.")
	flag.StringVar(&leaderElectionID, "leader-election-id", "myrix-cell-manager.myrix.io", "Leader election lease name.")
	flag.StringVar(&runtimeNamespace, "runtime-namespace", envOr("MYRIX_RUNTIME_NAMESPACE", "myrix-runtime"), "The only namespace this manager may write workloads in.")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	crlog.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	logger := crlog.Log.WithName("setup")

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme,
		// Restrict the cache to the runtime namespace: the manager cannot
		// even observe other namespaces' workloads.
		Cache: cache.Options{
			DefaultNamespaces: map[string]cache.Config{runtimeNamespace: {}},
		},
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       leaderElectionID,
	})
	if err != nil {
		logger.Error(err, "unable to start manager")
		os.Exit(1)
	}

	reconciler := &controller.CellReconciler{
		Client:    mgr.GetClient(),
		Scheme:    mgr.GetScheme(),
		Driver:    driver.NewHTTPClient(),
		Recorder:  mgr.GetEventRecorderFor("myrix-cell-manager"),
		Clock:     controller.RealClock{},
		Namespace: runtimeNamespace,
	}
	if err := reconciler.SetupWithManager(mgr); err != nil {
		logger.Error(err, "unable to create controller", "controller", "TenantCell")
		os.Exit(1)
	}

	internal := &apiserver.Server{
		Namespace: runtimeNamespace,
		Token:     os.Getenv("MYRIX_INTERNAL_TOKEN"),
		Cells:     &controller.WantRunningClient{Client: mgr.GetClient(), Namespace: runtimeNamespace},
	}
	if handler := internal.Handler(); handler != nil {
		srv := &http.Server{
			Addr:              internalAddr,
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
		}
		useTLS := internalCertFile != "" && internalKeyFile != ""
		if (internalCertFile == "") != (internalKeyFile == "") {
			logger.Error(nil, "internal TLS needs both --internal-tls-cert-file and --internal-tls-key-file; refusing to start the internal API")
			os.Exit(1)
		}
		go func() {
			var err error
			if useTLS {
				err = srv.ListenAndServeTLS(internalCertFile, internalKeyFile)
			} else {
				logger.Info("internal wake API is serving plaintext; terminate TLS in the mesh or provide a serving certificate")
				err = srv.ListenAndServe()
			}
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Error(err, "internal API server stopped")
			}
		}()
	} else {
		logger.Info("internal wake API disabled: MYRIX_INTERNAL_TOKEN is not set")
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		logger.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		logger.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	logger.Info("starting cell manager", "namespace", runtimeNamespace, "leaderElection", enableLeaderElection)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		logger.Error(err, "manager exited with an error")
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
