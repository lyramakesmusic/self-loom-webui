import os
import json
import requests
import time
from datetime import datetime
from flask import Flask, render_template, Response, request, jsonify
import re
from dotenv import load_dotenv
import threading
import queue
import random
import glob

load_dotenv()

app = Flask(__name__)

SEED_TEXT = """Where are you? I swear I"""

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# ============================
# Configuration and Setup
# ============================

# Paths
home_dir = os.path.expanduser('~')
CONFIG_DIR = os.path.join(home_dir, '.openrouter-flask')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')

# Default configuration
DEFAULT_CONFIG = {
    'token': '',
    'model': 'z-ai/glm-4.5-air:free',
    'instruct_model': 'z-ai/glm-4.5-air:free',
    'endpoint': 'https://openrouter.ai/api/v1/completions',
    'temperature': 1.0,
    'min_p': 0.02,
    'presence_penalty': 0.1,
    'repetition_penalty': 1.1,
    'max_tokens': 128,
    'max_new_tokens': 128,
    'base_context_limit': 8000,
    'grader_context_limit': 4000
}

# Ensure directories exist
os.makedirs(CONFIG_DIR, exist_ok=True)

# ============================
# Configuration Functions
# ============================

def load_config():
    """Load application configuration from file"""
    config = DEFAULT_CONFIG.copy()
    
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                saved_config = json.load(f)
                config.update(saved_config)
        except Exception as e:
            print(f"Error loading configuration: {e}")
    else:
        save_config(config)
        
    return config

def save_config(config):
    """Save application configuration to file"""
    try:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        return True
    except Exception as e:
        print(f"Error saving configuration: {e}")
        return False

# Load configuration at app startup
config = load_config()

# Model endpoints - base for completions, instruct for grading
BASE_MODEL = config['model']
INSTRUCT_MODEL = config['instruct_model']

BASE_CONTEXT_LIMIT = config['base_context_limit']
GRADER_CONTEXT_LIMIT = config['grader_context_limit']

# Token is now loaded from config, with fallback to environment variable

def get_completion_with_retry(prompt, model=BASE_MODEL, max_tokens=128, temperature=1.0, max_retries=10):
    """
    Get single completion from OpenRouter API with retry logic
    prompt = input text string
    Returns completion text string, retries until success
    """
    # Use config token, fallback to environment variable
    token = config.get('token') or os.getenv("OPENROUTER_API_KEY")
    if not token:
        return f" [No API token configured]"
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "min_p": 0.02
    }
    
    for attempt in range(max_retries):
        try:
            response = requests.post(f"{OPENROUTER_BASE_URL}/completions", 
                                   headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            
            data = response.json()
            return data["choices"][0]["text"]
            
        except requests.exceptions.RequestException as e:
            status_code = getattr(e.response, 'status_code', None) if hasattr(e, 'response') else None
            
            # Calculate delay with short initial backoff, then exponential
            if attempt == 0:
                base_delay = 0.1
            elif attempt == 1:
                base_delay = 0.2
            elif attempt == 2:
                base_delay = 0.5
            else:
                base_delay = min(60, (2 ** (attempt - 1)))  # Cap at 60 seconds
            jitter = random.uniform(0.0, 0.2)
            delay = base_delay + jitter
            
            # Special handling for rate limits
            if status_code == 429:
                delay = 65  # Wait longer for rate limit (60s + jitter)
                print(f"Rate limited on attempt {attempt + 1}, waiting {delay:.1f}s...")
            elif status_code in [502, 503, 408]:
                print(f"Server error {status_code} on attempt {attempt + 1}, retrying in {delay:.1f}s...")
            elif status_code in [401, 402, 403]:
                print(f"Auth/credits error {status_code}, stopping retries")
                break
            else:
                print(f"API error on attempt {attempt + 1}: {e}, retrying in {delay:.1f}s...")
            
            if attempt < max_retries - 1:
                time.sleep(delay)
            
        except Exception as e:
            print(f"Unexpected error on attempt {attempt + 1}: {e}")
            if attempt < max_retries - 1:
                if attempt == 0:
                    delay = 0.1
                elif attempt == 1:
                    delay = 0.2
                else:
                    delay = min(10, 2 ** attempt) + random.uniform(0.0, 0.2)
                time.sleep(delay)
    
    return f" [Completion failed after {max_retries} attempts]"

def get_completion(prompt, model=BASE_MODEL, max_tokens=128, temperature=1.0):
    """
    Get single completion from OpenRouter API
    prompt = input text string  
    Returns completion text string
    """
    return get_completion_with_retry(prompt, model, max_tokens, temperature)

def stream_completion(prompt, model=BASE_MODEL, max_tokens=128, temperature=1.0):
    """
    Stream completion from OpenRouter API token by token
    prompt = input text string
    Yields token strings as they arrive
    """
    # Use config token, fallback to environment variable
    token = config.get('token') or os.getenv("OPENROUTER_API_KEY")
    if not token:
        yield "data: " + json.dumps({"error": "No API token configured"}) + "\n\n"
        return
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "min_p": 0.02,
        "stream": True
    }
    
    try:
        with requests.post(f"{OPENROUTER_BASE_URL}/completions", 
                          headers=headers, json=payload, stream=True, timeout=60) as r:
            r.raise_for_status()
            buffer = ""
            for chunk in r.iter_content(chunk_size=1024, decode_unicode=True):
                if chunk:
                    buffer += chunk
                    while True:
                        line_end = buffer.find('\n')
                        if line_end == -1:
                            break
                        line = buffer[:line_end].strip()
                        buffer = buffer[line_end + 1:]
                        
                        if line.startswith('data: '):
                            data = line[6:]
                            if data == '[DONE]':
                                return
                            try:
                                data_obj = json.loads(data)
                                content = data_obj["choices"][0].get("text", "")
                                if content:
                                    yield content
                            except json.JSONDecodeError:
                                continue
    except Exception as e:
        print(f"Stream completion failed: {e}")

def get_grader_choice_with_retry(context, completions, max_retries=10, model=INSTRUCT_MODEL):
    """
    Ask instruct model to pick best completion with retry logic
    context = truncated text string for context
    completions = list of 5 completion text strings
    max_retries = number of retry attempts
    model = model to use for grading
    Returns integer index (1-5) of chosen completion
    """
    # Use config token, fallback to environment variable
    token = config.get('token') or os.getenv("OPENROUTER_API_KEY")
    if not token:
        return random.randint(1, 5)  # Fallback to random choice
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    options_text = ""
    for i, completion in enumerate(completions, 1):
        options_text += f"{i}. {completion}\n\n"
    
    prompt = f"{context}\n\n{options_text}\n\nWhich of the following 5 completions of the given text is more interesting? reply with only a single number - 1, 2, 3, 4, 5. You should pick whichever completion is the most absolutely batshit insane, weird, or interesting. You're looking for the most *interesting* one."
    
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user", 
                "content": prompt
            }
        ]
    }
    
    for attempt in range(max_retries):
        try:
            response = requests.post(f"{OPENROUTER_BASE_URL}/chat/completions",
                                   headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            
            data = response.json()
            choice_text = data["choices"][0]["message"]["content"].strip()
            
            match = re.search(r'\b([1-5])\b', choice_text)
            if match:
                return int(match.group(1))
            else:
                print(f"Grader gave weird response: {choice_text}, retrying...")
                
        except requests.exceptions.RequestException as e:
            status_code = getattr(e.response, 'status_code', None) if hasattr(e, 'response') else None
            
            if attempt == 0:
                base_delay = 0.1
            elif attempt == 1:
                base_delay = 0.2
            elif attempt == 2:
                base_delay = 0.5
            else:
                base_delay = min(60, (2 ** (attempt - 1)))
            jitter = random.uniform(0.0, 0.2)
            delay = base_delay + jitter
            
            if status_code == 429:
                delay = 65
                print(f"Grader rate limited on attempt {attempt + 1}, waiting {delay:.1f}s...")
            elif status_code in [502, 503, 408]:
                print(f"Grader server error {status_code} on attempt {attempt + 1}, retrying in {delay:.1f}s...")
            elif status_code in [401, 402, 403]:
                print(f"Grader auth/credits error {status_code}, stopping retries")
                break
            else:
                print(f"Grader API error on attempt {attempt + 1}: {e}, retrying in {delay:.1f}s...")
            
            if attempt < max_retries - 1:
                time.sleep(delay)
                
        except Exception as e:
            print(f"Grader unexpected error on attempt {attempt + 1}: {e}")
            if attempt < max_retries - 1:
                if attempt == 0:
                    delay = 0.1
                elif attempt == 1:
                    delay = 0.2
                else:
                    delay = min(10, 2 ** attempt) + random.uniform(0.0, 0.2)
                time.sleep(delay)
    
    fallback_choice = random.randint(1, 5)
    print(f"Grader failed after {max_retries} attempts, using random choice: {fallback_choice}")
    return fallback_choice

def get_grader_choice(context, completions, model=INSTRUCT_MODEL):
    """
    Ask instruct model to pick best completion
    context = truncated text string for context
    completions = list of 5 completion text strings
    model = model to use for grading
    Returns integer index (1-5) of chosen completion
    """
    return get_grader_choice_with_retry(context, completions, model=model)

def truncate_text(text, max_tokens):
    """
    Truncate text to approximately max_tokens
    text = input text string
    max_tokens = integer limit for tokens
    Returns truncated text string from end
    """
    # max_chars = approximate character limit
    max_chars = max_tokens * 4
    if len(text) <= max_chars:
        return text
    
    return text[-max_chars:]

def generate_completions_parallel(prompt, count=5, max_tokens=128, temperature=1.0, min_p=0.02, model=BASE_MODEL):
    """
    Generate multiple completions concurrently using threading
    prompt = input text string
    count = number of completions to generate
    max_tokens = maximum tokens per completion
    temperature = temperature for generation
    min_p = min_p for generation
    model = model to use for generation
    Returns list of completion text strings
    """
    completions = [None] * count
    threads = []
    
    def worker(index):
        completion = get_completion_with_retry(prompt, model=model, max_tokens=max_tokens, temperature=temperature)
        completions[index] = completion
    
    for i in range(count):
        thread = threading.Thread(target=worker, args=(i,))
        threads.append(thread)
        thread.start()
    
    for thread in threads:
        thread.join()
    
    return completions

def get_documents_dir():
    """Get or create documents directory"""
    docs_dir = "documents"
    if not os.path.exists(docs_dir):
        os.makedirs(docs_dir)
    return docs_dir

def save_document(name, content):
    """
    Save document with given name
    name = document name string
    content = document content string
    """
    try:
        docs_dir = get_documents_dir()
        filename = os.path.join(docs_dir, f"{name}.txt")
        
        with open(filename, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Saved document: {name}")
        return True
    except Exception as e:
        print(f"Failed to save document {name}: {e}")
        return False

def load_document(name):
    """
    Load document by name
    name = document name string
    Returns document content or None
    """
    try:
        docs_dir = get_documents_dir()
        filename = os.path.join(docs_dir, f"{name}.txt")
        
        if os.path.exists(filename):
            with open(filename, 'r', encoding='utf-8') as f:
                return f.read()
        return None
    except Exception as e:
        print(f"Failed to load document {name}: {e}")
        return None

def generate_document_name(content):
    """Generate a 2-4 word document name based on content using AI"""
    # Truncate content to fit in grader context limit
    truncated_content = truncate_text(content, GRADER_CONTEXT_LIMIT)
    
    prompt = f"""Based on this text content, generate a short, descriptive document name that is 2-4 words long. The name should capture the main theme, setting, or key elements of the story.

Text content:
{truncated_content}

Respond with ONLY the document name, nothing else. Example formats:
- "Lighthouse Mystery"
- "Ocean Storm Night" 
- "Ancient Forest Discovery"
- "Desert Caravan Journey"

Document name:"""
    
    try:
        response = get_completion(prompt, model=INSTRUCT_MODEL, max_tokens=20)
        # Clean up response - remove quotes, extra whitespace, newlines
        name = response.strip().strip('"').strip("'").strip()
        # Ensure it's reasonable length
        if len(name) > 50:
            name = name[:50]
        return name if name else "Untitled"
    except Exception as e:
        print(f"Error generating document name: {e}")
        return "Untitle"

def list_documents():
    """
    List all documents with metadata
    Returns list of document info dicts
    """
    try:
        docs_dir = get_documents_dir()
        pattern = os.path.join(docs_dir, "*.txt")
        files = glob.glob(pattern)
        
        documents = []
        for filepath in files:
            name = os.path.splitext(os.path.basename(filepath))[0]
            stat = os.stat(filepath)
            documents.append({
                'name': name,
                'modified': stat.st_mtime
            })
        
        # Sort by modification time, newest first
        documents.sort(key=lambda x: x['modified'], reverse=True)
        return documents
    except Exception as e:
        print(f"Failed to list documents: {e}")
        return []

@app.route('/')
def index():
    """Serve main page"""
    token_set = bool(config['token'])
    return render_template('index.html', token_set=token_set, config=config)

@app.route('/set_token', methods=['POST'])
def set_token():
    """Set the API token"""
    token = request.form.get('token')
    if not token:
        return jsonify({'success': False, 'error': 'No token provided'})
    
    config['token'] = token
    if save_config(config):
        return jsonify({'success': True})
    else:
        return jsonify({'success': False, 'error': 'Failed to save token'})

@app.route('/api/documents')
def api_list_documents():
    """API endpoint to list all documents"""
    documents = list_documents()
    return jsonify(documents)

@app.route('/api/documents/save', methods=['POST'])
def api_save_document():
    """API endpoint to save a document"""
    data = request.get_json()
    name = data.get('name', '').strip()
    content = data.get('content', '')
    
    if not name:
        return jsonify({'error': 'Document name required'}), 400
    
    success = save_document(name, content)
    if success:
        return jsonify({'message': 'Document saved successfully'})
    else:
        return jsonify({'error': 'Failed to save document'}), 500

@app.route('/api/documents/load/<name>')
def api_load_document(name):
    """API endpoint to load a document"""
    content = load_document(name)
    if content is not None:
        return jsonify({'name': name, 'content': content})
    else:
        return jsonify({'error': 'Document not found'}), 404

@app.route('/api/documents/rename', methods=['POST'])
def api_rename_document():
    """API endpoint to rename a document"""
    data = request.get_json()
    old_name = data.get('old_name', '').strip()
    new_name = data.get('new_name', '').strip()
    
    if not old_name or not new_name:
        return jsonify({'error': 'Both old_name and new_name required'}), 400
    
    try:
        docs_dir = get_documents_dir()
        old_filename = os.path.join(docs_dir, f"{old_name}.txt")
        new_filename = os.path.join(docs_dir, f"{new_name}.txt")
        
        if not os.path.exists(old_filename):
            return jsonify({'error': 'Document not found'}), 404
        
        if os.path.exists(new_filename):
            return jsonify({'error': 'Document with new name already exists'}), 400
        
        os.rename(old_filename, new_filename)
        return jsonify({'message': f'Document renamed from "{old_name}" to "{new_name}"'})
    except Exception as e:
        print(f"Failed to rename document {old_name} to {new_name}: {e}")
        return jsonify({'error': 'Failed to rename document'}), 500

@app.route('/api/documents/delete/<name>', methods=['DELETE'])
def api_delete_document(name):
    """API endpoint to delete a document"""
    try:
        docs_dir = get_documents_dir()
        filename = os.path.join(docs_dir, f"{name}.txt")
        
        if os.path.exists(filename):
            os.remove(filename)
            return jsonify({'message': f'Document "{name}" deleted successfully'})
        else:
            return jsonify({'error': 'Document not found'}), 404
    except Exception as e:
        print(f"Failed to delete document {name}: {e}")
        return jsonify({'error': 'Failed to delete document'}), 500

@app.route('/api/save_models', methods=['POST'])
def save_models():
    """API endpoint to save the last used model IDs"""
    try:
        data = request.get_json()
        base_model = data.get('base_model')
        grader_model = data.get('grader_model')
        
        if base_model:
            config['model'] = base_model
        if grader_model:
            config['instruct_model'] = grader_model
            
        save_config(config)
        
        return jsonify({'message': 'Models saved successfully'})
    except Exception as e:
        print(f"Failed to save models: {e}")
        return jsonify({'error': 'Failed to save models'}), 500

@app.route('/api/get_models')
def get_models():
    """API endpoint to get the last used model IDs"""
    try:
        return jsonify({
            'base_model': config.get('model', BASE_MODEL),
            'grader_model': config.get('instruct_model', INSTRUCT_MODEL)
        })
    except Exception as e:
        print(f"Failed to get models: {e}")
        return jsonify({'error': 'Failed to get models'}), 500

@app.route('/generate')
def generate():
    """
    SSE endpoint for text generation
    """
    custom_seed = request.args.get('seed', '')
    if custom_seed:
        seed_text = custom_seed
    else:
        seed_text = SEED_TEXT
    
    # Get generation settings from request
    max_new_tokens = int(request.args.get('max_new_tokens', 128))
    temperature = float(request.args.get('temperature', 1.0))
    min_p = float(request.args.get('min_p', 0.02))
    base_model = request.args.get('base_model', BASE_MODEL)
    grader_model = request.args.get('grader_model', INSTRUCT_MODEL)
    
    # Save the models for next time
    if base_model != BASE_MODEL or grader_model != INSTRUCT_MODEL:
        config['model'] = base_model
        config['instruct_model'] = grader_model
        save_config(config)
    
    def generate_stream():
        full_text = seed_text
        
        yield f"data: {json.dumps({'type': 'init', 'text': full_text})}\n\n"
        
        iteration = 0
        while True:  # Endless looming
            iteration += 1
            
            yield f"data: {json.dumps({'type': 'iteration_start', 'iteration': iteration})}\n\n"
            
            base_context = truncate_text(full_text, BASE_CONTEXT_LIMIT)
            
            yield f"data: {json.dumps({'type': 'completion_start', 'index': 1})}\n\n"
            yield f"data: {json.dumps({'type': 'completion_start', 'index': 2})}\n\n"
            yield f"data: {json.dumps({'type': 'completion_start', 'index': 3})}\n\n"
            yield f"data: {json.dumps({'type': 'completion_start', 'index': 4})}\n\n"
            yield f"data: {json.dumps({'type': 'completion_start', 'index': 5})}\n\n"
            
            completions = generate_completions_parallel(base_context, count=5, max_tokens=max_new_tokens, temperature=temperature, min_p=min_p, model=base_model)
            
            for i, completion_text in enumerate(completions, 1):
                yield f"data: {json.dumps({'type': 'completion_done', 'index': i, 'text': completion_text})}\n\n"
            
            yield f"data: {json.dumps({'type': 'grading_start'})}\n\n"
            
            grader_context = truncate_text(full_text, GRADER_CONTEXT_LIMIT)
            chosen_index = get_grader_choice(grader_context, completions, model=grader_model)
            
            if chosen_index and 1 <= chosen_index <= len(completions):
                chosen_text = completions[chosen_index - 1]
                yield f"data: {json.dumps({'type': 'grading_done', 'chosen_index': chosen_index, 'chosen_text': chosen_text})}\n\n"
                
                full_text += chosen_text
                yield f"data: {json.dumps({'type': 'text_updated', 'full_text': full_text})}\n\n"
                
                # After 3 iterations, generate a document name
                if iteration == 3:
                    try:
                        document_name = generate_document_name(full_text)
                        yield f"data: {json.dumps({'type': 'document_named', 'name': document_name})}\n\n"
                    except Exception as e:
                        print(f"Failed to generate document name: {e}")
                
            else:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Grader failed'})}\n\n"
                break
            
            time.sleep(1)
    
    return Response(generate_stream(), mimetype='text/event-stream',
                   headers={'Cache-Control': 'no-cache'})

if __name__ == '__main__':
    # Check if token is configured (either in config or environment)
    token = config.get('token') or os.getenv("OPENROUTER_API_KEY")
    if not token:
        print("No OpenRouter API token found. Please set token via web interface or .env file")
        print("Starting server anyway - token can be set via web interface...")
    
    print("Starting self-loom server...")
    app.run(debug=True, host='0.0.0.0', port=5000)