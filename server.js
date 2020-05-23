const express = require('express');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');
const regression = require('regression');

const parser = new Readline();
const pcVoc = 0.4, pcIsc = 0.1, pcS0i = 0.6, pcS0f = 0.92, pcS1f = 0.4, Vth=0.026;
let port,
    dinamicMeasure,
    ivMeasure,
    i,
    result,
    Voc,
    Isc,
    Vmp,
    Imp,
    Pmp,
    n,
    Io,
    Rso,
    Rsho,
    Rs,
    Rsh,
    Iph,
    FF,
    S0,
    S1,
    C,
    potencia,
    usbConnection = false,
    dadoPronto = false,
    po = [],
    pontos = [],
    chav0 = [],
    chav1 = [],
    progress,
    erro = false,
    measuring = false;


const app = express();

app.use(express.static('.'));
app.listen(8080, function () {
    console.log('app started');
});

//usb auto connection to ESP32

SerialPort.list((err, ports)=> {
    ports.forEach((_port) => {
        if (_port.manufacturer === 'Silicon Labs') {
            port = new SerialPort(_port.comName, {baudRate: 115200});
            port.pipe(parser);
            usbConnection = true;
        }
    });
});

//routes

app.get('/ajaxSet', (req, res) => {
    let rtn = {};
    rtn.chegou = false;
    if (!measuring) {
        port.write('r');
        progress = 0;
        measuring = true;
    }

    res.send(rtn);
});


//todo: change to ws
app.get('/ajaxConecao', (req, res) => {
    let rtn = {};
    rtn.conexao = usbConnection;
    res.send(rtn);
});

app.get('/ajaxMain', (req, res) => {
    let rtn = {};
    if (erro) {
        rtn.erro = true;
        erro = false;
    } else if (dadoPronto) {
        rtn.chegou = true;
        rtn.dadosIv = ivMeasure;
        rtn.pot = potencia;
        rtn.din = dinamicMeasure;
        rtn.maxima_potencia = Pmp;
        rtn.tensao_maxima_potencia = Vmp;
        rtn.corrente_maxima_potencia = Imp;
        rtn.corrente_cc = Isc;
        rtn.tensao_ca = Voc;
        rtn.rs = Rs;
        rtn.rp = Rsh;
        rtn.cd = C;
        dadoPronto = false;
    } else {
        rtn.chegou = false;
        rtn.progresso = progress;
    }
    res.send(rtn);
});

parser.on('data', line => {
    let json;
    try {
        json = JSON.parse(line);
    } catch (e) {
        console.log('JSON parse Error');
        return;
    }

    if (json.data) {
        try {
            potencia = [];
            ivMeasure = json.dataIv;
            dinamicMeasure = json.dataDin;

            let ivMeasure = ivMeasure.filter(({voltage}) => voltage !== -1);

            let powerMeasure = ivMeasure.map(({voltage, current}) => ({
                voltage,
                current,
                power: voltage * current
            }));

            const {Vmp, Imp, Pmp} = calcPmp(powerMeasure);

            let chav0 = first_chav = dinamicMeasure.filter( ({switching}) => switching === 0 );
            let chav1 = second_chav = dinamicMeasure.filter( ({switching}) => switching === 1 );

            Voc = ivMeasure[0].voltage;
            Isc = ivMeasure[ivMeasure.length - 1].current;

            const {Rso, Rsho} = extractRes(ivMeasure, Voc, Isc);
            calcCelik(Rsho, Rso, Vmp, Imp, Pmp, Voc, Isc);
            extractCap(first_chav, second_chav);
            dadoPronto = true;
            measuring = false;
        } catch (e) {
            console.log(e);
            erro = true;
        }
    } else if (json.progresso >= 0) {
        progress = json.progresso;
    } else if (json.terminouIv == true) {
        port.write('a');
    }

});


function extractRes(ivMeasure, Voc, Isc) {
    let points = [];
    ivMeasure.forEach( measure => {
        if(measure.current < (Isc * pcIsc) ) {
            points = [...points, [measure.voltage, measure.current]];    
        }
    });
    
    let regression_result = regression.linear(points, {precision: 5});
    let Rso = -1 / regression_result.equation[0];
    
    points = [];
    ivMeasure.reduceRight( (lastPoint, measure) => {
        if(measure.voltage < (Voc * pcVoc) && (lastPoint.length === 0 || (measure.voltage !== lastPoint.voltage))){
            points = [...points, [measure.voltage, measure.current]];
            return measure;
        }
    }, []);

    regression_result = regression.linear(points, {precision: 5});
    let Rsho = -1 / regression_result.equation[0];
    return {Rso, Rsho};
}

function extractCap(chav0, chav1) {
        //change to split
    let points = chav0.reduce( (acc, el, index ,arr) => {
        if( (index+1) >= (arr.length * pcS0i) && (index+1) < (arr.length * pcS0f)){
            return [...acc, [el.time, el.voltage]];    
        }
    }, []);

    let regression_result = regression.linear(points, {precision: 5});
    let S0 = regression_result.equation[0];
    
    points = chav1.reduce( (acc, el, index, arr) =>{
        if((index+1) >= (arr.length * pcS1f)){
            return [...acc, [el.time, el.voltage]];   
        }
    }, []);
    
    regression_result = regression.linear(points, {precision: 5});
    let S1 = regression_result.equation[0];
    
    let C = (-S0 * 0.000022) / (S0 - S1);
}

function calcPmp(powerMeasure) {
    let maxPower = powerMeasure.reduce((max_power, power) => {
        if(max_power.power < power.power)
            return power;
    }, -1);

    Vmp = max_power.voltage;
    Imp = max_power.current;
    Pmp = max_power.power;
    return {Vmp, Imp, Pmp};
}

function calcCelik(Rsho, Rso, Vmp, Imp, Pmp, Voc, Isc ) {
    Rsh = Rsho;
    n = (Vmp + Rso * Imp - Voc) / (Vth * (Math.log(Isc - Vmp / Rsho - Imp) - Math.log(Isc - Voc / Rsh) + Imp / (Isc - Voc / Rsho)));
    Io = (Isc - Voc / Rsh) * Math.exp(-Voc / (n * Vth));
    Rs = Rso - n * Vth * Math.exp(-Voc / (n * Vth)) / Io;
    Iph = Isc * (1 + Rs / Rsh) + Io * (Math.exp(Isc * Rs / (n * Vth) - 1));
    FF = (Vmp * Imp) / (Voc * Isc);
    console.log('n: ' + n);
    console.log('Io: ' + Io);
    console.log('Iph: ' + Iph);
}
