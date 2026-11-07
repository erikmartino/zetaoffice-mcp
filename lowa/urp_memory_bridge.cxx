/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
// SPDX-License-Identifier: MIT
//
// Custom LOWA patch: a NATIVE, in-memory UNO URP endpoint.
//
// It provides a real C++ com.sun.star.connection.XConnection backed by a
// thread-safe byte queue, and runs LibreOffice's own `binaryurp` bridge over it
// via BridgeFactory.createBridge("", "urp", conn, provider). The only JS
// surface is four opaque byte functions (urpOpen/Push/Pull/Close); no UNO
// interfaces are implemented in JavaScript, and the Wasm never opens a socket.
//
// The host (browser/Node) owns the actual "UNO socket" and relays bytes to
// these functions. See ../README.md and ../PROTOCOL.md.
//
// This file is a source patch for a custom LOWA build; it is not compiled by
// the stock ZetaOffice binaries. Build it into the wasm (e.g. as part of the
// soffice executable target) so the Embind bindings are registered.

#include <algorithm>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <unordered_map>
#include <vector>

#include <emscripten/bind.h>

#include <comphelper/processfactory.hxx>
#include <cppuhelper/implbase.hxx>
#include <rtl/ref.hxx>
#include <rtl/ustring.hxx>
#include <sal/types.h>

#include <com/sun/star/bridge/XBridge.hpp>
#include <com/sun/star/bridge/XBridgeFactory.hpp>
#include <com/sun/star/bridge/XInstanceProvider.hpp>
#include <com/sun/star/connection/XConnection.hpp>
#include <com/sun/star/lang/XMultiComponentFactory.hpp>
#include <com/sun/star/uno/XComponentContext.hpp>

namespace css = ::com::sun::star;

namespace {

// A byte pipe whose read() blocks on a condition variable. Because it is pure
// C++, the bridge's osl::Thread can call read() without crossing into JS (the
// failure mode that made a JS-implemented XConnection unusable).
class MemoryConnection final
    : public cppu::WeakImplHelper<css::connection::XConnection> {
public:
    // XConnection
    sal_Int32 SAL_CALL read(
        css::uno::Sequence<sal_Int8>& aReadBytes, sal_Int32 nBytesToRead) override
    {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [this] { return !in_.empty() || closed_; });
        if (in_.empty()) {
            return 0; // closed
        }
        const std::size_t avail =
            std::min<std::size_t>(in_.size(), static_cast<std::size_t>(nBytesToRead));
        aReadBytes.realloc(static_cast<sal_Int32>(avail));
        sal_Int8* p = aReadBytes.getArray();
        for (std::size_t i = 0; i < avail; ++i) {
            p[i] = in_.front();
            in_.pop_front();
        }
        return static_cast<sal_Int32>(avail);
    }

    void SAL_CALL write(const css::uno::Sequence<sal_Int8>& aBytes) override {
        std::lock_guard<std::mutex> lock(mutex_);
        const sal_Int8* p = aBytes.getConstArray();
        for (sal_Int32 i = 0; i < aBytes.getLength(); ++i) {
            out_.push_back(p[i]);
        }
    }

    void SAL_CALL flush() override {}

    void SAL_CALL close() override {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            closed_ = true;
        }
        cv_.notify_all();
    }

    OUString SAL_CALL getDescription() override { return u"memory,urp"_ustr; }

    // Host-side pumps (called from JS via Embind).
    void push(const std::vector<sal_Int8>& bytes) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            for (sal_Int8 b : bytes) {
                in_.push_back(b);
            }
        }
        cv_.notify_all();
    }

    std::vector<sal_Int8> pull(std::size_t maxn) {
        std::lock_guard<std::mutex> lock(mutex_);
        const std::size_t n = std::min(maxn, out_.size());
        std::vector<sal_Int8> result(out_.begin(), out_.begin() + n);
        out_.erase(out_.begin(), out_.begin() + n);
        return result;
    }

private:
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<sal_Int8> in_;
    std::deque<sal_Int8> out_;
    bool closed_ = false;
};

// Serves the bootstrap object ids a URP client asks for by name.
class ContextProvider final
    : public cppu::WeakImplHelper<css::bridge::XInstanceProvider> {
public:
    explicit ContextProvider(css::uno::Reference<css::uno::XComponentContext> ctx)
        : ctx_(std::move(ctx))
    {
    }

    css::uno::Reference<css::uno::XInterface> SAL_CALL
    getInstance(const OUString& name) override
    {
        if (name == u"StarOffice.ComponentContext"_ustr
            || name == u"uno.ComponentContext"_ustr)
        {
            return ctx_.get();
        }
        if (name == u"StarOffice.ServiceManager"_ustr) {
            return ctx_->getServiceManager().get();
        }
        return nullptr;
    }

private:
    css::uno::Reference<css::uno::XComponentContext> ctx_;
};

struct Entry {
    css::uno::Reference<css::connection::XConnection> connection;
    MemoryConnection* raw = nullptr;
    css::uno::Reference<css::bridge::XBridge> bridge;
};

std::unordered_map<int, Entry> g_entries;
std::mutex g_mutex;

} // namespace

// --- Embind surface ---------------------------------------------------------

void urpOpen(int id) {
    css::uno::Reference<css::uno::XComponentContext> ctx =
        comphelper::getProcessComponentContext();

    rtl::Reference<MemoryConnection> mem = new MemoryConnection();
    css::uno::Reference<css::connection::XConnection> conn(mem.get());
    css::uno::Reference<css::bridge::XInstanceProvider> provider =
        new ContextProvider(ctx);

    css::uno::Reference<css::bridge::XBridgeFactory> factory(
        ctx->getServiceManager()->createInstanceWithContext(
            "com.sun.star.bridge.BridgeFactory", ctx),
        css::uno::UNO_QUERY);

    css::uno::Reference<css::bridge::XBridge> bridge =
        factory->createBridge("", "urp", conn, provider);

    std::lock_guard<std::mutex> guard(g_mutex);
    Entry& e = g_entries[id];
    e.connection = conn;
    e.raw = mem.get();
    e.bridge = bridge;
}

void urpPush(int id, emscripten::val bytes) {
    std::vector<sal_Int8> v =
        emscripten::convertJSArrayToNumberVector<sal_Int8>(bytes);
    std::lock_guard<std::mutex> guard(g_mutex);
    auto it = g_entries.find(id);
    if (it != g_entries.end() && it->second.raw) {
        it->second.raw->push(v);
    }
}

emscripten::val urpPull(int id) {
    std::vector<sal_Int8> v;
    {
        std::lock_guard<std::mutex> guard(g_mutex);
        auto it = g_entries.find(id);
        if (it == g_entries.end() || !it->second.raw) {
            return emscripten::val::null();
        }
        v = it->second.raw->pull(1u << 20);
    }
    if (v.empty()) {
        return emscripten::val::null();
    }
    // Copy into a JS-owned Uint8Array (never a view over the wasm heap).
    emscripten::val array = emscripten::val::global("Uint8Array").new_(v.size());
    for (std::size_t i = 0; i < v.size(); ++i) {
        array.set(i, static_cast<int>(v[i]));
    }
    return array;
}

void urpClose(int id) {
    std::lock_guard<std::mutex> guard(g_mutex);
    auto it = g_entries.find(id);
    if (it != g_entries.end()) {
        it->second.connection->close();
        g_entries.erase(it);
    }
}

EMSCRIPTEN_BINDINGS(uno_urp_memory_bridge) {
    emscripten::function("urpOpen", &urpOpen);
    emscripten::function("urpPush", &urpPush);
    emscripten::function("urpPull", &urpPull);
    emscripten::function("urpClose", &urpClose);
}
